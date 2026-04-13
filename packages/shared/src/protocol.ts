import type { Speaker } from "./types";

// ── Token Service Protocol (Desktop ↔ CF Worker) ──

export interface TokenRequest {
  model: string;
  speaker: Speaker;
  sourceLang: string;
  targetLang: string;
}

export interface TokenResponse {
  token: string;
  expiresAt: string;
  dailyRemainingMs: number;
  tokensGeneratedToday: number;
}

export interface TokenError {
  code:
    | "unauthorized"
    | "rate_limited"
    | "usage_exhausted"
    | "token_generation_failed"
    | "invalid_request";
  message: string;
  retryAfterMs?: number;
}

// ── Gemini Live API Message Types ──

export interface GeminiSystemInstruction {
  parts: { text: string }[];
}

export interface GeminiSessionSetupConfig {
  responseModalities: ("TEXT" | "AUDIO")[];
  systemInstruction?: GeminiSystemInstruction;
  inputAudioTranscription?: Record<string, never>;
  speechConfig?: {
    voiceConfig?: {
      prebuiltVoiceConfig?: { voiceName: string };
    };
  };
  realtimeInputConfig?: {
    automaticActivityDetection?: {
      disabled?: boolean;
      startOfSpeechSensitivity?: "START_SENSITIVITY_LOW" | "START_SENSITIVITY_MEDIUM" | "START_SENSITIVITY_HIGH";
      endOfSpeechSensitivity?: "END_SENSITIVITY_LOW" | "END_SENSITIVITY_MEDIUM" | "END_SENSITIVITY_HIGH";
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
    };
  };
  contextWindowCompression?: {
    triggerTokens: number;
    slidingWindowTokenCount: number;
  };
  sessionResumption?: {
    handle?: string;
  };
}

export interface GeminiSetupMessage {
  setup: {
    model: string;
    generationConfig: GeminiSessionSetupConfig;
  };
}

export interface GeminiRealtimeInputMessage {
  realtimeInput: {
    mediaChunks: { data: string; mimeType: string }[];
  };
}

export interface GeminiClientContentMessage {
  clientContent: {
    turnComplete: boolean;
  };
}

export interface GeminiServerContent {
  serverContent?: {
    modelTurn?: {
      parts: { text?: string; inlineData?: { mimeType: string; data: string } }[];
    };
    inputTranscription?: {
      parts: { text: string }[];
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  setupComplete?: Record<string, never>;
  sessionResumptionUpdate?: {
    newHandle?: string;
    resumable?: boolean;
  };
}

// ── Language Configuration ──

export const SUPPORTED_LANGUAGES = [
  "en-US", "hi-IN", "es-ES", "fr-FR", "de-DE", "it-IT",
  "pt-BR", "ru-RU", "ja-JP", "ko-KR", "zh-CN", "ar-SA",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  "en-US": "English",
  "hi-IN": "Hindi",
  "es-ES": "Spanish",
  "fr-FR": "French",
  "de-DE": "German",
  "it-IT": "Italian",
  "pt-BR": "Portuguese",
  "ru-RU": "Russian",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "zh-CN": "Chinese",
  "ar-SA": "Arabic",
};
