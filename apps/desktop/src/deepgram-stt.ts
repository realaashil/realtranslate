import { EventEmitter } from "events";
import WebSocket from "ws";

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
  sampleRate?: number;
  label: string;
}

export interface SentenceEvent {
  text: string;       // Final transcript for this sentence/turn
  isEndOfTurn: boolean;
}

export interface PartialEvent {
  text: string;       // Interim/partial transcript
}

/**
 * Deepgram Flux STT via v2 WebSocket.
 * Streams audio, emits partial transcripts and complete sentences on EndOfTurn.
 */
export class DeepgramSTT extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: DeepgramConfig;
  private connected = false;

  constructor(config: DeepgramConfig) {
    super();
    this.config = config;
  }

  connect(): void {
    if (this.ws) { try { this.ws.close(); } catch { /* */ } }

    const model = this.config.model ?? "flux-general-en";
    const sampleRate = this.config.sampleRate ?? 16000;

    const url = `wss://api.deepgram.com/v2/listen?model=${model}&encoding=linear16&sample_rate=${sampleRate}&punctuate=true&interim_results=true`;

    this.ws = new WebSocket(url, ["token", this.config.apiKey]);

    this.ws.on("open", () => {
      this.connected = true;
      console.log(`[Deepgram:${this.config.label}] Connected (${model})`);
      this.emit("connected");
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[Deepgram:${this.config.label}] Error:`, err.message);
      this.emit("error", err);
    });

    this.ws.on("close", (code: number) => {
      this.connected = false;
      console.log(`[Deepgram:${this.config.label}] Closed: ${code}`);
      this.emit("close", code);
    });
  }

  sendAudio(base64Pcm: string): void {
    if (!this.connected || !this.ws) return;
    const buffer = Buffer.from(base64Pcm, "base64");
    this.ws.send(buffer);
  }

  disconnect(): void {
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    let msg: DeepgramMessage;
    try {
      const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString();
      msg = JSON.parse(text) as DeepgramMessage;
    } catch { return; }

    // v2 Flux: EndOfTurn event
    if (msg.type === "EndOfTurn" || msg.type === "EagerEndOfTurn") {
      console.log(`[Deepgram:${this.config.label}] ${msg.type}`);
      this.emit("end-of-turn");
      return;
    }

    // v2 transcript result
    if (msg.type === "Results" || msg.channel) {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      const transcript = alt.transcript?.trim();
      if (!transcript) return;

      if (msg.is_final) {
        this.emit("sentence", {
          text: transcript,
          isEndOfTurn: false,
        } satisfies SentenceEvent);
      } else {
        this.emit("partial", {
          text: transcript,
        } satisfies PartialEvent);
      }
    }
  }
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
}
