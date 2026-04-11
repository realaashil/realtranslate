import WebSocket, { type RawData } from "ws";

type Speaker = "you" | "them";

type ClientMessage =
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
    };

type ServerMessage =
  | {
      type: "translation_chunk";
      utteranceId: string;
      chunk: string;
      done: boolean;
    }
  | {
      type: "error";
      code:
        | "unauthorized"
        | "device_mismatch"
        | "invalid_payload"
        | "translation_failed";
      message: string;
      utteranceId?: string;
    }
  | {
      type: "rate_limited";
      retryAfterMs: number;
    }
  | {
      type: "session_expired";
      resetAtUtc: string;
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
  onConnectionStateChange?: (state: ProxyConnectionState) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

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
  private readonly onConnectionStateChange?: (
    state: ProxyConnectionState,
  ) => void;

  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private pending = new Map<string, PendingRequest>();
  private state: ProxyConnectionState = "disconnected";

  constructor(options: ProxyClientOptions) {
    this.url = options.url;
    this.onConnectionStateChange = options.onConnectionStateChange;
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

  private flushPending(reason: Error): void {
    this.pending.forEach((entry) => {
      entry.reject(reason);
    });
    this.pending.clear();
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

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.resendPendingRequests();
    });

    socket.on("message", (data: RawData) => {
      const raw = typeof data === "string" ? data : data.toString();
      const message = parseServerMessage(raw);

      if (!message) {
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
        if (!message.utteranceId) {
          return;
        }

        const pending = this.pending.get(message.utteranceId);
        if (!pending) {
          return;
        }

        this.pending.delete(message.utteranceId);
        pending.reject(new Error(message.message));
      }
    });

    socket.on("error", () => {
      this.setState("error");
    });

    socket.on("close", () => {
      this.socket = null;

      if (!this.shouldReconnect) {
        this.setState("disconnected");
        this.flushPending(new Error("Proxy connection closed"));
        return;
      }

      const delay =
        RETRY_DELAYS_MS[
          Math.min(this.reconnectAttempt, RETRY_DELAYS_MS.length - 1)
        ];

      this.reconnectAttempt += 1;
      this.setState("reconnecting");

      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        void this.connect();
      }, delay);
    });
  }

  async connect(): Promise<void> {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.shouldReconnect = true;
    this.setState("connecting");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      this.attachSocketHandlers(socket);

      socket.once("open", () => resolve());
      socket.once("error", (error: Error) => reject(toError(error)));
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setState("disconnected");
  }

  dispose(): void {
    this.disconnect();
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
