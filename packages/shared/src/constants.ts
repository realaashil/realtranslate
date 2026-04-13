import type { QueueConfig } from "./types";

export const QUEUE_CONFIG: QueueConfig = {
  listeningTimeoutMs: 5000,
  timestampTieWindowMs: 50,
};

export const AUDIO_CONFIG = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  chunkDurationMs: 25,
  mimeType: "audio/pcm;rate=16000",
} as const;

export const GEMINI_MODELS = {
  live: "gemini-3.1-flash-live-preview",
  liveNativeAudio: "gemini-2.5-flash-native-audio-preview-12-2025",
} as const;

export const GEMINI_API = {
  wsBase: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent",
  wsBaseConstrained: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  tokenEndpoint: "https://generativelanguage.googleapis.com/v1alpha/authTokens",
} as const;

export const SESSION_LIMITS = {
  dailySessionMs: 7_200_000,
  warningThresholdRatio: 0.8,
  geminiSessionDurationMs: 900_000,
  tokenLifetimeMs: 1_800_000,
  tokenRefreshBeforeExpiryMs: 300_000,
  maxTokensPerUserPerHour: 10,
  maxSessionDurationMs: 1_800_000, // 30 minutes per session
  sessionWarningBeforeEndMs: 300_000, // warn 5 min before
} as const;

export const CONTEXT_WINDOW_COMPRESSION = {
  triggerTokens: 100_000,
  slidingWindowTokenCount: 80_000,
} as const;

export const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
