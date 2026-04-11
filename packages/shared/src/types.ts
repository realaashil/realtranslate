export type Speaker = "you" | "them";

export type UtteranceStatus =
  | "listening"
  | "transcribing"
  | "translating"
  | "done"
  | "failed";

export interface Utterance {
  id: string;
  speaker: Speaker;
  timestamp: number;
  status: UtteranceStatus;
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  confidence: number;
}

export interface QueueConfig {
  listeningTimeoutMs: number;
  timestampTieWindowMs: number;
}
