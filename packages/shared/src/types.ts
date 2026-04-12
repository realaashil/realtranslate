export type Speaker = "you" | "them";

export type UtteranceStatus =
  | "listening"
  | "processing"
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
}

export interface QueueConfig {
  listeningTimeoutMs: number;
  timestampTieWindowMs: number;
}
