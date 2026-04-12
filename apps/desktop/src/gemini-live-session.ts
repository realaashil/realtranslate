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

export interface TranscriptEvent { text: string; isFinal: boolean }
export interface TranslationEvent { text: string; isFinal: boolean }

interface ServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: { parts?: { text?: string; inlineData?: { data: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

// Only create a new utterance after this much silence
const NEW_UTTERANCE_SILENCE_MS = 5000;

export class GeminiLiveSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private _state: SessionState = "disconnected";
  private config: GeminiLiveSessionConfig;
  private reconnectAttempt = 0;
  private shouldReconnect = false;

  // Accumulated text across all Gemini turns within one utterance
  private allTranscript = "";
  private allTranslation = "";
  // Text for the current Gemini turn (resets on turnComplete)
  private curTranscript = "";
  private curTranslation = "";

  private newUtteranceTimer: NodeJS.Timeout | null = null;

  constructor(config: GeminiLiveSessionConfig) {
    super();
    this.config = config;
  }

  get state(): SessionState { return this._state; }
  private setState(s: SessionState): void { this._state = s; this.emit("state-change", s); }

  // Full text = all previous turns + current in-progress turn
  private fullTranscript(): string {
    const parts = [this.allTranscript, this.curTranscript].filter(Boolean);
    return parts.join(" ");
  }

  private fullTranslation(): string {
    const parts = [this.allTranslation, this.curTranslation].filter(Boolean);
    return parts.join(" ");
  }

  // ── Connection ──

  connect(): void {
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.close(); } catch { /* */ } }
    this.shouldReconnect = true;
    this.setState("connecting");

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${this.config.token}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => { this.reconnectAttempt = 0; this.setState("setup"); this.sendSetup(); });
    this.ws.on("message", (d: WebSocket.Data) => this.handleMsg(d));
    this.ws.on("error", (e: Error) => { console.error(`[GL:${this.config.label}] err:`, e.message); this.emit("error", e); });
    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[GL:${this.config.label}] closed: ${code} ${reason}`);
      this.clearTimers();
      this.setState("disconnected");
      this.emit("close", code, reason.toString());
      this.maybeReconnect();
    });
  }

  private sendSetup(): void {
    const model = this.config.model ?? GEMINI_MODELS.live;
    const targetLang = LANGUAGE_NAMES[this.config.targetLang] ?? this.config.targetLang;

    this.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
        },
        systemInstruction: {
          parts: [{ text: `You are a live translator. Translate everything you hear into ${targetLang}. Output ONLY the translation. No commentary, no explanations. Be concise and natural.` }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            prefixPaddingMs: 20,
            silenceDurationMs: 1000,
          },
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
      },
    }));
  }

  // ── Message handling ──

  private handleMsg(data: WebSocket.Data): void {
    let msg: ServerMessage;
    try { msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as Buffer).toString()); } catch { return; }

    if (msg.setupComplete) {
      console.log(`[GL:${this.config.label}] setup complete`);
      this.setState("ready");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // inputTranscription streams word-by-word as user speaks
    if (sc.inputTranscription?.text) {
      // Cancel new-utterance timer — speech is happening
      if (this.newUtteranceTimer) { clearTimeout(this.newUtteranceTimer); this.newUtteranceTimer = null; }

      this.curTranscript += sc.inputTranscription.text;
      this.emit("transcript", { text: this.fullTranscript(), isFinal: false } satisfies TranscriptEvent);
    }

    // outputTranscription arrives alongside audio response
    if (sc.outputTranscription?.text) {
      if (this.newUtteranceTimer) { clearTimeout(this.newUtteranceTimer); this.newUtteranceTimer = null; }

      this.curTranslation += sc.outputTranscription.text;
      this.emit("translation", { text: this.fullTranslation(), isFinal: false } satisfies TranslationEvent);
    }

    if (sc.interrupted) {
      // Gemini stopped generating — archive what we have for this turn
      this.archiveCurrentTurn();
    }

    if (sc.turnComplete) {
      // Gemini finished responding to one natural utterance.
      // Archive this turn's text and start the new-utterance timer.
      this.archiveCurrentTurn();

      console.log(`[GL:${this.config.label}] turn done | t:"${this.allTranscript.slice(-40)}" | tr:"${this.allTranslation.slice(-40)}"`);

      // Start timer — if no new speech for 15s, finalize the utterance
      this.startNewUtteranceTimer();
    }
  }

  private archiveCurrentTurn(): void {
    if (this.curTranscript) {
      this.allTranscript = this.allTranscript
        ? this.allTranscript + " " + this.curTranscript
        : this.curTranscript;
    }
    if (this.curTranslation) {
      this.allTranslation = this.allTranslation
        ? this.allTranslation + " " + this.curTranslation
        : this.curTranslation;
    }
    this.curTranscript = "";
    this.curTranslation = "";
  }

  private startNewUtteranceTimer(): void {
    if (this.newUtteranceTimer) clearTimeout(this.newUtteranceTimer);
    this.newUtteranceTimer = setTimeout(() => {
      this.newUtteranceTimer = null;

      const transcript = this.fullTranscript();
      const translation = this.fullTranslation();

      if (transcript) this.emit("transcript", { text: transcript, isFinal: true });
      if (translation) this.emit("translation", { text: translation, isFinal: true });

      console.log(`[GL:${this.config.label}] utterance done | t:"${transcript.slice(0, 60)}" | tr:"${translation.slice(0, 60)}"`);

      this.allTranscript = "";
      this.allTranslation = "";
      this.curTranscript = "";
      this.curTranslation = "";
      this.emit("turn-complete");
    }, NEW_UTTERANCE_SILENCE_MS);
  }

  // ── Audio sending — just forward everything, Gemini handles VAD ──

  sendAudio(base64Pcm: string): void {
    if (this._state !== "ready") return;
    this.send(JSON.stringify({
      realtimeInput: { audio: { data: base64Pcm, mimeType: "audio/pcm" } },
    }));
  }

  // ── Lifecycle ──

  updateToken(token: string): void { this.config = { ...this.config, token }; }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.close(1000); } catch { /* */ } this.ws = null; }
    this.setState("disconnected");
  }

  private clearTimers(): void {
    if (this.newUtteranceTimer) { clearTimeout(this.newUtteranceTimer); this.newUtteranceTimer = null; }
  }

  private send(d: string): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(d); }

  private maybeReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = RETRY_BACKOFF_MS[Math.min(this.reconnectAttempt, RETRY_BACKOFF_MS.length - 1)] ?? 16000;
    this.reconnectAttempt++;
    console.log(`[GL:${this.config.label}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => { if (this.shouldReconnect) this.connect(); }, delay);
  }
}
