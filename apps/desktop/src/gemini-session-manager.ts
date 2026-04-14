import WebSocket from "ws";
import {
  SESSION_LIMITS,
  type SupportedLanguage,
  type Speaker,
  type Utterance,
  type UtteranceStatus,
  ConversationQueue,
} from "@realtime/shared";

export type SessionState = "disconnected" | "connecting" | "ready" | "error";

export interface LanguageSettings {
  youSource: SupportedLanguage;
  youTarget: SupportedLanguage;
  themSource: SupportedLanguage;
  themTarget: SupportedLanguage;
}

export interface GeminiSessionManagerConfig {
  tokenServiceUrl: string;
  deepgramApiKey?: string;
  deviceId: string;
  language: LanguageSettings;
}

export interface SessionManagerSnapshot {
  isRunning: boolean;
  youSessionState: SessionState;
  themSessionState: SessionState;
  utterances: Utterance[];
  dailyRemainingMs: number | null;
  error: string | null;
}

type SessionManagerListener = (snapshot: SessionManagerSnapshot) => void;

type ServerMsg =
  | { type: "auth_ok" }
  | { type: "config_ok" }
  | { type: "stt_connected"; speaker: Speaker }
  | { type: "partial"; speaker: Speaker; text: string }
  | { type: "sentence"; speaker: Speaker; text: string; translation: string | null }
  | { type: "end_of_turn"; speaker: Speaker }
  | { type: "error"; message: string }
  | { type: "session_ending"; remainingMs: number };

// Track each sentence by index, not by text matching
interface SpeakerState {
  utteranceId: string | null;
  sentences: string[];
  translations: (string | null)[];  // null = pending translation
  partial: string;
  pendingEnd: boolean;
  pendingTranslations: number;  // count of sentences awaiting translation
}

const emptySpeakerState = (): SpeakerState => ({
  utteranceId: null,
  sentences: [],
  translations: [],
  partial: "",
  pendingEnd: false,
  pendingTranslations: 0,
});

export class GeminiSessionManager {
  private config: GeminiSessionManagerConfig;
  private ws: WebSocket | null = null;
  private queue = new ConversationQueue();
  private isRunning = false;
  private youState: SessionState = "disconnected";
  private themState: SessionState = "disconnected";
  private dailyRemainingMs: number | null = null;
  private lastError: string | null = null;
  private listeners: SessionManagerListener[] = [];
  private accessToken: string | null = null;
  private sessionStartedAt: number | null = null;
  private you: SpeakerState = emptySpeakerState();
  private them: SpeakerState = emptySpeakerState();

  constructor(config: GeminiSessionManagerConfig) { this.config = config; }

  private sp(speaker: Speaker): SpeakerState { return speaker === "you" ? this.you : this.them; }

  onSnapshot(listener: SessionManagerListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  }

  getSnapshot(): SessionManagerSnapshot {
    return {
      isRunning: this.isRunning,
      youSessionState: this.youState,
      themSessionState: this.themState,
      utterances: this.queue.getOrdered(),
      dailyRemainingMs: this.dailyRemainingMs,
      error: this.lastError,
    };
  }

  setAccessToken(token: string | null): void { this.accessToken = token; }

  updateConfig(config: Partial<GeminiSessionManagerConfig>): void {
    if (config.tokenServiceUrl) this.config.tokenServiceUrl = config.tokenServiceUrl;
    if (config.language) this.config.language = config.language;
  }

  async startSessions(): Promise<void> {
    if (this.isRunning) return;
    if (!this.accessToken) { this.lastError = "Not authenticated"; this.emitSnapshot(); return; }

    this.isRunning = true;
    this.lastError = null;
    this.queue.clear();
    this.sessionStartedAt = Date.now();
    this.you = emptySpeakerState();
    this.them = emptySpeakerState();
    this.emitSnapshot();
    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    const base = this.config.tokenServiceUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({
      token: this.accessToken!,
      deviceId: this.config.deviceId,
    });
    const wsUrl = `${base}/ws?${params}`;
    const wsConnectStart = Date.now();
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log(`[Latency] WS connected in ${Date.now() - wsConnectStart}ms`);
      this.send({ type: "auth", token: this.accessToken! });
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString();
      let msg: ServerMsg;
      try { msg = JSON.parse(text) as ServerMsg; } catch { return; }
      this.handleServerMessage(msg);
    });

    this.ws.on("error", (err: Error) => {
      console.error("[SM] WS error:", err.message);
      this.lastError = err.message;
      this.emitSnapshot();
    });

    this.ws.on("close", () => {
      console.log("[SM] WS closed");
      this.youState = "disconnected";
      this.themState = "disconnected";
      this.emitSnapshot();
    });
  }

  private handleServerMessage(msg: ServerMsg): void {
    if (msg.type === "auth_ok") {
      console.log(`[Latency] auth_ok received, session setup ${Date.now() - this.sessionStartedAt!}ms from start`);
      this.send({
        type: "config",
        youTarget: this.config.language.youTarget,
        themTarget: this.config.language.themTarget,
      });
      this.send({ type: "start" });
      return;
    }

    if (msg.type === "config_ok") return;

    if (msg.type === "stt_connected") {
      console.log(`[Latency] ${msg.speaker} STT ready, ${Date.now() - this.sessionStartedAt!}ms from start`);
      if (msg.speaker === "you") this.youState = "ready";
      else this.themState = "ready";
      this.emitSnapshot();
      return;
    }

    if (msg.type === "error") {
      this.lastError = msg.message;
      this.emitSnapshot();
      return;
    }

    if (msg.type === "session_ending") {
      const mins = Math.ceil(msg.remainingMs / 60000);
      this.lastError = `Session ending in ${mins} min`;
      this.emitSnapshot();
      return;
    }

    if (msg.type === "partial") {
      this.handlePartial(msg.speaker, msg.text);
      return;
    }

    if (msg.type === "sentence") {
      this.handleSentence(msg.speaker, msg.text, msg.translation);
      return;
    }

    if (msg.type === "end_of_turn") {
      this.handleEndOfTurn(msg.speaker);
      return;
    }
  }

  // ── Utterance timing ──
  private utteranceCreatedAt = new Map<string, number>();
  private sentenceTimings = new Map<string, number>(); // "speaker:sentenceIdx" → timestamp

  // ── Partial: speech in progress ──

  private handlePartial(speaker: Speaker, text: string): void {
    const s = this.sp(speaker);

    // New speech arrived — cancel any pending finalization
    s.pendingEnd = false;
    s.partial = text;

    const utteranceId = this.ensureUtterance(speaker);
    if (!utteranceId) return;

    const fullOriginal = [...s.sentences, text].filter(Boolean).join(" ");
    const fullTranslated = s.translations.filter(Boolean).join(" ");

    this.queue.upsert(utteranceId, {
      status: "processing" as UtteranceStatus,
      originalText: fullOriginal,
      translatedText: fullTranslated || undefined,
    });
    this.emitSnapshot();
  }

  // ── Sentence: final transcript (with or without translation) ──

  private handleSentence(speaker: Speaker, text: string, translation: string | null): void {
    const s = this.sp(speaker);

    if (translation === null) {
      // New sentence detected, translation pending
      // Cancel pending finalization — more content coming
      s.pendingEnd = false;
      s.partial = "";
      const sentIdx = s.sentences.length;
      s.sentences.push(text);
      s.translations.push(null);
      s.pendingTranslations++;
      this.sentenceTimings.set(`${speaker}:${sentIdx}`, Date.now());
      console.log(`[Latency] ${speaker} sentence[${sentIdx}] received, pending translation: "${text.slice(0, 60)}"`);

      const utteranceId = this.ensureUtterance(speaker);
      if (!utteranceId) return;

      this.queue.upsert(utteranceId, {
        status: "processing" as UtteranceStatus,
        originalText: s.sentences.join(" "),
        translatedText: s.translations.filter(Boolean).join(" ") || undefined,
      });
      this.emitSnapshot();
    } else {
      // Translation arrived for an existing sentence
      // Find the FIRST sentence that matches and has no translation yet
      const idx = s.sentences.findIndex(
        (sent, i) => sent === text && s.translations[i] === null
      );

      if (idx >= 0) {
        // Update existing utterance
        s.translations[idx] = translation;
        s.pendingTranslations = Math.max(0, s.pendingTranslations - 1);
        const sentKey = `${speaker}:${idx}`;
        const sentAt = this.sentenceTimings.get(sentKey);
        if (sentAt) {
          console.log(`[Latency] ${speaker} sentence[${idx}] translated in ${Date.now() - sentAt}ms: "${translation.slice(0, 60)}"`);
          this.sentenceTimings.delete(sentKey);
        }

        if (s.utteranceId) {
          this.queue.upsert(s.utteranceId, {
            translatedText: s.translations.filter(Boolean).join(" "),
          });
          this.emitSnapshot();
        }
      } else if (s.utteranceId) {
        // Sentence not found in current — might be a late arrival.
        // Append to current utterance anyway.
        s.sentences.push(text);
        s.translations.push(translation);

        this.queue.upsert(s.utteranceId, {
          originalText: s.sentences.join(" "),
          translatedText: s.translations.filter(Boolean).join(" "),
        });
        this.emitSnapshot();
      }
      // If no current utterance, it's a very late arrival — discard silently.

      this.tryFinalize(speaker);
    }
  }

  // ── End of turn: Deepgram detected silence ──

  private handleEndOfTurn(speaker: Speaker): void {
    const s = this.sp(speaker);
    s.pendingEnd = true;
    this.tryFinalize(speaker);
  }

  // ── Try to finalize: only when pendingEnd=true AND all translations are in ──

  private tryFinalize(speaker: Speaker): void {
    const s = this.sp(speaker);
    if (!s.pendingEnd) return;
    if (s.pendingTranslations > 0) return;

    // All translations received + silence detected → finalize
    if (s.utteranceId) {
      const createdAt = this.utteranceCreatedAt.get(s.utteranceId);
      if (createdAt) {
        console.log(`[Latency] ${speaker} utterance finalized in ${Date.now() - createdAt}ms (${s.sentences.length} sentences)`);
        this.utteranceCreatedAt.delete(s.utteranceId);
      }
      this.queue.upsert(s.utteranceId, { status: "done" as UtteranceStatus });
    }

    // Reset speaker state for next utterance
    const fresh = emptySpeakerState();
    if (speaker === "you") this.you = fresh;
    else this.them = fresh;

    this.emitSnapshot();
  }

  // ── Ensure utterance exists for speaker ──

  private ensureUtterance(speaker: Speaker): string | null {
    if (!this.isRunning) return null;
    const s = this.sp(speaker);
    if (s.utteranceId) return s.utteranceId;

    const utterance = this.queue.create({
      speaker,
      timestamp: Date.now(),
      sourceLang: speaker === "you" ? this.config.language.youSource : this.config.language.themSource,
      targetLang: speaker === "you" ? this.config.language.youTarget : this.config.language.themTarget,
    });

    s.utteranceId = utterance.id;
    this.utteranceCreatedAt.set(utterance.id, Date.now());
    console.log(`[Latency] ${speaker} utterance created: ${utterance.id}`);
    return utterance.id;
  }

  // ── Send to worker ──

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  pushMicAudio(base64Pcm: string): void {
    this.send({ type: "audio", speaker: "you", data: base64Pcm });
  }

  pushSystemAudio(base64Pcm: string): void {
    this.send({ type: "audio", speaker: "them", data: base64Pcm });
  }

  muteSpeaker(speaker: Speaker): void {
    this.send({ type: "mute", speaker });
    if (speaker === "you") this.youState = "disconnected";
    else this.themState = "disconnected";
    this.emitSnapshot();
  }

  unmuteSpeaker(speaker: Speaker): void {
    this.send({ type: "unmute", speaker });
    if (speaker === "you") this.youState = "connecting";
    else this.themState = "connecting";
    this.emitSnapshot();
  }

  stopSessions(): void {
    this.send({ type: "stop" });
    this.isRunning = false;
    this.sessionStartedAt = null;
    this.you = emptySpeakerState();
    this.them = emptySpeakerState();
    this.youState = "disconnected";
    this.themState = "disconnected";
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
    this.emitSnapshot();
  }

  clearUtterances(): void {
    this.queue.clear();
    this.emitSnapshot();
  }

  dispose(): void {
    this.stopSessions();
    this.listeners = [];
  }
}
