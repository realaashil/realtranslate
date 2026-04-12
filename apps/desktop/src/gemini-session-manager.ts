import {
  SESSION_LIMITS,
  GEMINI_MODELS,
  type SupportedLanguage,
  type Speaker,
  type Utterance,
  type UtteranceStatus,
  ConversationQueue,
} from "@realtime/shared";
import {
  GeminiLiveSession,
  type GeminiLiveSessionConfig,
  type SessionState,
} from "./gemini-live-session";
import {
  TokenServiceClient,
  TokenServiceError,
} from "./token-service-client";

export interface LanguageSettings {
  youSource: SupportedLanguage;
  youTarget: SupportedLanguage;
  themSource: SupportedLanguage;
  themTarget: SupportedLanguage;
}

export interface GeminiSessionManagerConfig {
  tokenServiceUrl: string;
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

export class GeminiSessionManager {
  private config: GeminiSessionManagerConfig;
  private tokenClient: TokenServiceClient;
  private youSession: GeminiLiveSession | null = null;
  private themSession: GeminiLiveSession | null = null;
  private queue = new ConversationQueue();
  private isRunning = false;
  private dailyRemainingMs: number | null = null;
  private lastError: string | null = null;
  private listeners: SessionManagerListener[] = [];
  private tokenRefreshTimers: NodeJS.Timeout[] = [];
  private currentYouUtteranceId: string | null = null;
  private currentThemUtteranceId: string | null = null;
  private accessToken: string | null = null;
  private sessionStartedAt: number | null = null;

  constructor(config: GeminiSessionManagerConfig) {
    this.config = config;
    this.tokenClient = new TokenServiceClient({
      serviceUrl: config.tokenServiceUrl,
    });
  }

  onSnapshot(listener: SessionManagerListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  getSnapshot(): SessionManagerSnapshot {
    return {
      isRunning: this.isRunning,
      youSessionState: this.youSession?.state ?? "disconnected",
      themSessionState: this.themSession?.state ?? "disconnected",
      utterances: this.queue.getOrdered(),
      dailyRemainingMs: this.dailyRemainingMs,
      error: this.lastError,
    };
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  updateConfig(config: Partial<GeminiSessionManagerConfig>): void {
    if (config.tokenServiceUrl) {
      this.config.tokenServiceUrl = config.tokenServiceUrl;
      this.tokenClient.updateConfig({ serviceUrl: config.tokenServiceUrl });
    }
    if (config.language) {
      this.config.language = config.language;
    }
  }

  async startSessions(): Promise<void> {
    if (this.isRunning) return;
    if (!this.accessToken) {
      this.lastError = "Not authenticated";
      this.emitSnapshot();
      return;
    }

    this.isRunning = true;
    this.lastError = null;
    this.queue.clear();
    this.sessionStartedAt = Date.now();
    this.emitSnapshot();

    try {
      await Promise.all([
        this.startSession("you"),
        this.startSession("them"),
      ]);
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : "Failed to start sessions";
      this.emitSnapshot();
    }
  }

  private async startSession(speaker: Speaker): Promise<void> {
    if (!this.accessToken) return;

    const token = await this.acquireToken();
    if (!token) return;

    const sourceLang =
      speaker === "you"
        ? this.config.language.youSource
        : this.config.language.themSource;
    const targetLang =
      speaker === "you"
        ? this.config.language.youTarget
        : this.config.language.themTarget;

    const sessionConfig: GeminiLiveSessionConfig = {
      token: token.token,
      sourceLang,
      targetLang,
      label: speaker,
    };

    const session = new GeminiLiveSession(sessionConfig);
    this.wireSessionEvents(session, speaker);

    if (speaker === "you") {
      this.youSession = session;
    } else {
      this.themSession = session;
    }

    session.connect();
    this.scheduleTokenRefresh(speaker, token.expiresAt);
    this.emitSnapshot();
  }

  private wireSessionEvents(
    session: GeminiLiveSession,
    speaker: Speaker,
  ): void {
    session.on("state-change", () => {
      this.emitSnapshot();
    });

    session.on("transcript", (event) => {
      const utteranceId = this.ensureUtterance(speaker);
      if (!utteranceId) return;

      this.queue.upsert(utteranceId, {
        status: "processing" as UtteranceStatus,
        originalText: event.text,
      });
      this.emitSnapshot();
    });

    session.on("translation", (event) => {
      const utteranceId = this.ensureUtterance(speaker);
      if (!utteranceId) return;

      this.queue.upsert(utteranceId, {
        status: "processing" as UtteranceStatus,
        translatedText: event.text,
      });
      this.emitSnapshot();
    });

    session.on("turn-complete", () => {
      const utteranceId =
        speaker === "you"
          ? this.currentYouUtteranceId
          : this.currentThemUtteranceId;

      if (utteranceId) {
        const existing = this.queue.getById(utteranceId);
        if (existing && existing.status !== "failed") {
          this.queue.upsert(utteranceId, { status: "done" as UtteranceStatus });
        }
      }

      if (speaker === "you") {
        this.currentYouUtteranceId = null;
      } else {
        this.currentThemUtteranceId = null;
      }
      this.emitSnapshot();
    });

    session.on("interrupted", () => {
      if (speaker === "you") {
        this.currentYouUtteranceId = null;
      } else {
        this.currentThemUtteranceId = null;
      }
      this.emitSnapshot();
    });

    session.on("error", (err) => {
      console.error(`[SessionManager] ${speaker} session error:`, err.message);
    });

    session.on("close", () => {
      // Reconnection is handled by GeminiLiveSession internally
    });
  }

  private ensureUtterance(speaker: Speaker): string | null {
    if (!this.isRunning) return null;

    const currentId =
      speaker === "you"
        ? this.currentYouUtteranceId
        : this.currentThemUtteranceId;

    if (currentId) return currentId;

    const sourceLang =
      speaker === "you"
        ? this.config.language.youSource
        : this.config.language.themSource;
    const targetLang =
      speaker === "you"
        ? this.config.language.youTarget
        : this.config.language.themTarget;

    const utterance = this.queue.create({
      speaker,
      timestamp: Date.now(),
      sourceLang,
      targetLang,
    });

    if (speaker === "you") {
      this.currentYouUtteranceId = utterance.id;
    } else {
      this.currentThemUtteranceId = utterance.id;
    }

    return utterance.id;
  }

  private async acquireToken(): Promise<{
    token: string;
    expiresAt: string;
  } | null> {
    if (!this.accessToken) return null;

    try {
      const response = await this.tokenClient.requestToken(this.accessToken);
      this.dailyRemainingMs = response.dailyRemainingMs;
      return { token: response.token, expiresAt: response.expiresAt };
    } catch (err) {
      if (err instanceof TokenServiceError) {
        this.lastError = `Token error: ${err.message}`;
      } else {
        this.lastError =
          err instanceof Error ? err.message : "Token acquisition failed";
      }
      this.emitSnapshot();
      return null;
    }
  }

  private scheduleTokenRefresh(speaker: Speaker, expiresAt: string): void {
    const expiresAtMs = new Date(expiresAt).getTime();
    const refreshAt =
      expiresAtMs - Date.now() - SESSION_LIMITS.tokenRefreshBeforeExpiryMs;
    const delay = Math.max(refreshAt, 60_000); // At least 1 minute

    const timer = setTimeout(async () => {
      if (!this.isRunning) return;

      try {
        const newToken = await this.acquireToken();
        if (!newToken) return;

        const session =
          speaker === "you" ? this.youSession : this.themSession;
        if (session) {
          session.updateToken(newToken.token);
          session.disconnect();
          session.connect();
          this.scheduleTokenRefresh(speaker, newToken.expiresAt);
        }
      } catch (err) {
        console.error(
          `[SessionManager] Token refresh failed for ${speaker}:`,
          err,
        );
      }
    }, delay);

    this.tokenRefreshTimers.push(timer);
  }

  pushMicAudio(base64Pcm: string): void {
    this.youSession?.sendAudio(base64Pcm);
  }

  pushSystemAudio(base64Pcm: string): void {
    this.themSession?.sendAudio(base64Pcm);
  }

  stopSessions(): void {
    // Report actual usage duration
    if (this.sessionStartedAt && this.accessToken) {
      const durationMs = Date.now() - this.sessionStartedAt;
      void this.tokenClient.reportUsage(this.accessToken, durationMs);
    }

    this.isRunning = false;
    this.sessionStartedAt = null;
    this.currentYouUtteranceId = null;
    this.currentThemUtteranceId = null;

    for (const timer of this.tokenRefreshTimers) {
      clearTimeout(timer);
    }
    this.tokenRefreshTimers = [];

    this.youSession?.disconnect();
    this.themSession?.disconnect();
    this.youSession = null;
    this.themSession = null;

    this.emitSnapshot();
  }

  async resetUsage(): Promise<void> {
    if (!this.accessToken) return;
    await this.tokenClient.resetUsage(this.accessToken);
    this.dailyRemainingMs = SESSION_LIMITS.dailySessionMs;
    this.lastError = null;
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
