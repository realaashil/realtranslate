import type { Speaker } from "./types";

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
        | "translation_failed";
      message: string;
      utteranceId?: string;
    }
  | {
      type: "pong";
      sentAt: number;
    };
