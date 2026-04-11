import WebSocket, { type RawData } from "ws";

type Speaker = "you" | "them";

export type ClientMessage =
  | {
      type: "auth";
      token: string;
      deviceId: string;
    }
  | {
      type: "translate";
      utteranceId: string;
      text: string;
      sourceLang: string;
      targetLang: string;
      speaker: Speaker;
    }
  | {
      type: "ping";
      sentAt: number;
    }
  | {
      type: "disconnect";
      reason: "meeting_ended" | "user_stopped" | "shutdown";
    };

export type ServerMessage =
  | {
      type: "auth_ok";
      sessionId: string;
      dailyRemainingMs: number;
      rpmRemaining: number;
    }
  | {
      type: "translation_chunk";
      utteranceId: string;
      chunk: string;
      done: boolean;
    }
  | {
      type: "rate_warning";
      remaining: number;
      limit: number;
    }
  | {
      type: "rate_limited";
      retryAfterMs: number;
      utteranceId?: string;
    }
  | {
      type: "session_warning";
      dailyRemainingMs: number;
    }
  | {
      type: "session_expired";
      resetAtUtc: string;
    }
  | {
      type: "error";
      code:
        | "unauthorized"
        | "device_mismatch"
        | "invalid_payload"
        | "translation_failed"
        | "session_required"
        | "invalid_language"
        | "text_too_long";
      message: string;
      utteranceId?: string;
    }
  | {
      type: "pong";
      sentAt: number;
    };

export type ProxyConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

interface PendingRequest {
  input: TranslationRequestInput;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

interface TranslationRequestInput {
  utteranceId: string;
  text: string;
  sourceLang: string;
  targetLang: string;
  speaker: Speaker;
}

interface ProxyClientOptions {
  url: string;
  authToken?: string;
  deviceId?: string;
  heartbeatMs?: number;
  onConnectionStateChange?: (state: ProxyConnectionState) => void;
  onServerMessage?: (message: ServerMessage) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "string") {
    return new Error(value);
  }

  return new Error("Unknown proxy client error");
};

const parseServerMessage = (raw: string): ServerMessage | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const message = parsed as { type?: unknown };
    if (typeof message.type !== "string") {
      return null;
    }

    return parsed as ServerMessage;
  } catch {
    return null;
  }
};

export class TranslationProxyClient {
  private readonly url: string;
  private readonly authToken: string;
  private readonly deviceId: string;
  private readonly heartbeatMs: number;
  private readonly onConnectionStateChange?: (
    state: ProxyConnectionState,
  ) => void;
  private readonly onServerMessage?: (message: ServerMessage) => void;

  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private pending = new Map<string, PendingRequest>();
  private state: ProxyConnectionState = "disconnected";
  private authenticated = false;

  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(options: ProxyClientOptions) {
    this.url = options.url;
    this.authToken = options.authToken ?? process.env.PROXY_AUTH_TOKEN ?? "dev-token";
    this.deviceId = options.deviceId ?? process.env.PROXY_DEVICE_ID ?? "desktop-dev-device";
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.onServerMessage = options.onServerMessage;
  }

  get connectionState(): ProxyConnectionState {
    return this.state;
  }

  private setState(next: ProxyConnectionState): void {
    this.state = next;
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(next);
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearConnectTimeout(): void {
    if (!this.connectTimeout) {
      return;
    }

    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  private resolveConnect(): void {
    this.clearConnectTimeout();

    if (this.connectResolve) {
      this.connectResolve();
    }

    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
  }

  private rejectConnect(error: Error): void {
    this.clearConnectTimeout();

    if (this.connectReject) {
      this.connectReject(error);
    }

    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
  }

  private flushPending(reason: Error): void {
    this.pending.forEach((entry) => {
      entry.reject(reason);
    });
    this.pending.clear();
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();

    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.authenticated) {
        return;
      }

      this.send({
        type: "ping",
        sentAt: Date.now(),
      });
    }, this.heartbeatMs);
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Proxy socket is not connected");
    }

    this.socket.send(JSON.stringify(message));
  }

  private resendPendingRequests(): void {
    this.pending.forEach((entry) => {
      try {
        this.send({
          type: "translate",
          utteranceId: entry.input.utteranceId,
          text: entry.input.text,
          sourceLang: entry.input.sourceLang,
          targetLang: entry.input.targetLang,
          speaker: entry.input.speaker,
        });
      } catch (error) {
        entry.reject(toError(error));
        this.pending.delete(entry.input.utteranceId);
      }
    });
  }

  private failAuth(message: string): void {
    const error = new Error(message);
    this.authenticated = false;
    this.setState("error");
    this.rejectConnect(error);
    this.flushPending(error);
  }

  private handleServerMessage(message: ServerMessage): void {
    if (this.onServerMessage) {
      this.onServerMessage(message);
    }

    if (message.type === "auth_ok") {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.resolveConnect();
      this.startHeartbeat();
      this.resendPendingRequests();
      return;
    }

    if (message.type === "translation_chunk") {
      if (!message.done) {
        return;
      }

      const pending = this.pending.get(message.utteranceId);
      if (!pending) {
        return;
      }

      this.pending.delete(message.utteranceId);
      pending.resolve(message.chunk);
      return;
    }

    if (message.type === "error") {
      if (
        message.code === "unauthorized" ||
        message.code === "device_mismatch" ||
        message.code === "session_required"
      ) {
        this.failAuth(message.message);
      }

      if (!message.utteranceId) {
        return;
      }

      const pending = this.pending.get(message.utteranceId);
      if (!pending) {
        return;
      }

      this.pending.delete(message.utteranceId);
      pending.reject(new Error(message.message));
      return;
    }

    if (message.type === "rate_limited" && message.utteranceId) {
      const pending = this.pending.get(message.utteranceId);
      if (!pending) {
        return;
      }

      this.pending.delete(message.utteranceId);
      pending.reject(new Error(`Rate limited. Retry after ${message.retryAfterMs}ms`));
      return;
    }

    if (message.type === "session_expired") {
      this.flushPending(new Error(`Session expired. Resets at ${message.resetAtUtc}`));
    }
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on("open", () => {
      this.authenticated = false;

      try {
        this.send({
          type: "auth",
          token: this.authToken,
          deviceId: this.deviceId,
        });
      } catch (error) {
        this.failAuth(toError(error).message);
      }
    });

    socket.on("message", (data: RawData) => {
      const raw = typeof data === "string" ? data : data.toString();
      const message = parseServerMessage(raw);

      if (!message) {
        return;
      }

      this.handleServerMessage(message);
    });

    socket.on("error", (error: Error) => {
      this.setState("error");
      this.rejectConnect(toError(error));
    });

    socket.on("close", () => {
      this.socket = null;
      this.authenticated = false;
      this.clearHeartbeatTimer();

      if (!this.shouldReconnect) {
        this.setState("disconnected");
        this.rejectConnect(new Error("Proxy connection closed"));
        this.flushPending(new Error("Proxy connection closed"));
        return;
      }

      const delay =
        RETRY_DELAYS_MS[
          Math.min(this.reconnectAttempt, RETRY_DELAYS_MS.length - 1)
        ];

      this.reconnectAttempt += 1;
      this.setState("reconnecting");
      this.rejectConnect(new Error("Proxy connection interrupted"));

      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        void this.connect();
      }, delay);
    });
  }

  async connect(): Promise<void> {
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.shouldReconnect = true;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.clearConnectTimeout();
      this.connectTimeout = setTimeout(() => {
        this.rejectConnect(new Error("Proxy auth handshake timed out"));

        if (this.socket) {
          this.socket.close();
        }
      }, DEFAULT_CONNECT_TIMEOUT_MS);

      const socket = new WebSocket(this.url);
      this.socket = socket;
      this.attachSocketHandlers(socket);
    });

    return this.connectPromise;
  }

  disconnect(reason: "meeting_ended" | "user_stopped" | "shutdown" = "user_stopped"): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearConnectTimeout();

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.send({
          type: "disconnect",
          reason,
        });
      } catch {
        // Ignore send failures during shutdown.
      }
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.authenticated = false;
    this.setState("disconnected");
  }

  dispose(): void {
    this.disconnect("shutdown");
    this.rejectConnect(new Error("Proxy client disposed"));
    this.flushPending(new Error("Proxy client disposed"));
  }

  async translate(input: TranslationRequestInput): Promise<string> {
    await this.connect();

    return new Promise<string>((resolve, reject) => {
      this.pending.set(input.utteranceId, {
        input,
        resolve,
        reject,
      });

      try {
        this.send({
          type: "translate",
          utteranceId: input.utteranceId,
          text: input.text,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          speaker: input.speaker,
        });
      } catch (error) {
        this.pending.delete(input.utteranceId);
        reject(toError(error));
      }
    });
  }
}
