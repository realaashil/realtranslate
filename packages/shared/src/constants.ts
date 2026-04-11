import type { QueueConfig } from "./types";

export const QUEUE_CONFIG: QueueConfig = {
  listeningTimeoutMs: 5000,
  timestampTieWindowMs: 50,
};

export const VAD_CONFIG = {
  speechThreshold: 0.5,
  commaPauseMs: 300,
  sentencePauseMs: 800,
  paragraphPauseMs: 2000,
} as const;

export const SESSION_LIMITS = {
  dailySessionMs: 7_200_000,
  warningThresholdRatio: 0.8,
  idleGapMs: 30_000,
  maxCharsPerRequest: 1_000,
} as const;

export const RATE_LIMITS = {
  perUserRequestsPerMinute: 30,
  perUserConcurrentRequests: 5,
  globalRequestsPerMinute: 200,
  globalTokensPerMinute: 500_000,
} as const;

export const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
