import { EventEmitter } from "events";
import WebSocket from "ws";
import {
  GEMINI_MODELS,
  RETRY_BACKOFF_MS,
  type SupportedLanguage,
  LANGUAGE_NAMES,
} from "@realtime/shared";

export type SessionState =
  | "disconnected"
  | "connecting"
  | "setup"
  | "ready"
  | "error";

export interface GeminiLiveSessionConfig {
  token: string;
  model?: string;
  sourceLang: SupportedLanguage;
  targetLang: SupportedLanguage;
  label: string;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
}

export interface TranslationEvent {
  text: string;
  isFinal: boolean;
}

// ── Gemini Live API message types ──

interface ServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: {
      parts?: { text?: string; inlineData?: { data: string; mimeType: string } }[];
    };
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: unknown;
}

export class GeminiLiveSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private _state: SessionState = "disconnected";
  private config: GeminiLiveSessionConfig;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private pendingTranslation = "";
  private pendingTranscript = "";
  private turnStartedAt: number | null = null;
  private firstResponseAt: number | null = null;

  constructor(config: GeminiLiveSessionConfig) {
    super();
    this.config = config;
  }

  get state(): SessionState {
    return this._state;
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.emit("state-change", state);
  }

  connect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
    }

    this.shouldReconnect = true;
    this.setState("connecting");

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${this.config.token}`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.setState("setup");
      this.sendSetup();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.handleRawMessage(data);
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[GeminiLive:${this.config.label}] WS error:`, err.message);
      this.emit("error", err);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const r = reason.toString();
      console.log(`[GeminiLive:${this.config.label}] Closed: ${code} ${r}`);
      this.setState("disconnected");
      this.emit("close", code, r);
      this.maybeReconnect();
    });
  }

  private sendSetup(): void {
    const model = this.config.model ?? GEMINI_MODELS.live;
    const targetLangName =
      LANGUAGE_NAMES[this.config.targetLang] ?? this.config.targetLang;

    const setupMessage = {
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Puck",
              },
            },
          },
        },
        systemInstruction: {
          parts: [{
            text: `You are a live translator. Translate everything you hear into ${targetLangName}. Output ONLY the translation. No commentary, no explanations, no meta-text. Be concise and natural. Preserve tone and intent.`,
          }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 300,
            prefixPaddingMs: 10,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          },
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
      },
    };

    this.send(JSON.stringify(setupMessage));
  }

  private handleRawMessage(data: WebSocket.Data): void {
    let msg: ServerMessage;
    try {
      const text = typeof data === "string"
        ? data
        : Buffer.from(data as Buffer).toString();
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }

    // Setup complete
    if (msg.setupComplete) {
      console.log(`[GeminiLive:${this.config.label}] Setup complete`);
      this.setState("ready");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // Input transcription (what the speaker said)
    if (sc.inputTranscription?.text) {
      if (!this.turnStartedAt) {
        this.turnStartedAt = Date.now();
      }
      this.pendingTranscript += sc.inputTranscription.text;
      this.emit("transcript", {
        text: this.pendingTranscript,
        isFinal: false,
      } satisfies TranscriptEvent);
    }

    // Output transcription (the translated text — this is what we display)
    if (sc.outputTranscription?.text) {
      if (!this.firstResponseAt && this.turnStartedAt) {
        this.firstResponseAt = Date.now();
        console.log(
          `[latency:${this.config.label}] first-translation: ${this.firstResponseAt - this.turnStartedAt}ms`,
        );
      }
      this.pendingTranslation += sc.outputTranscription.text;
      this.emit("translation", {
        text: this.pendingTranslation,
        isFinal: false,
      } satisfies TranslationEvent);
    }

    // We ignore modelTurn audio data — we only care about transcriptions

    // Interrupted
    if (sc.interrupted) {
      console.log(
        `[latency:${this.config.label}] interrupted after ${this.turnStartedAt ? Date.now() - this.turnStartedAt : "?"}ms`,
      );
      this.pendingTranscript = "";
      this.pendingTranslation = "";
      this.turnStartedAt = null;
      this.firstResponseAt = null;
      this.emit("interrupted");
    }

    // Turn complete
    if (sc.turnComplete) {
      if (this.turnStartedAt) {
        console.log(
          `[latency:${this.config.label}] turn-complete: ${Date.now() - this.turnStartedAt}ms | transcript: "${this.pendingTranscript.slice(0, 60)}" | translation: "${this.pendingTranslation.slice(0, 60)}"`,
        );
      }

      if (this.pendingTranscript) {
        this.emit("transcript", {
          text: this.pendingTranscript,
          isFinal: true,
        } satisfies TranscriptEvent);
      }
      if (this.pendingTranslation) {
        this.emit("translation", {
          text: this.pendingTranslation,
          isFinal: true,
        } satisfies TranslationEvent);
      }
      this.pendingTranscript = "";
      this.pendingTranslation = "";
      this.turnStartedAt = null;
      this.firstResponseAt = null;
      this.emit("turn-complete");
    }
  }

  sendAudio(base64Pcm: string): void {
    if (this._state !== "ready") return;

    const message = {
      realtimeInput: {
        audio: {
          data: base64Pcm,
          mimeType: "audio/pcm",
        },
      },
    };
    this.send(JSON.stringify(message));
  }

  updateToken(token: string): void {
    this.config = { ...this.config, token };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(1000, "client disconnect"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setState("disconnected");
  }

  private send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private maybeReconnect(): void {
    if (!this.shouldReconnect) return;

    const delay =
      RETRY_BACKOFF_MS[
        Math.min(this.reconnectAttempt, RETRY_BACKOFF_MS.length - 1)
      ] ?? 16000;
    this.reconnectAttempt++;

    console.log(
      `[GeminiLive:${this.config.label}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }
}
