import { QUEUE_CONFIG } from "./constants";
import type { Speaker, Utterance, UtteranceStatus } from "./types";

export interface CreateUtteranceInput {
  speaker: Speaker;
  timestamp: number;
  sourceLang: string;
  targetLang: string;
}

export interface UpdateUtteranceInput {
  status?: UtteranceStatus;
  originalText?: string;
  translatedText?: string;
}

const buildUtteranceId = (speaker: Speaker, timestamp: number): string =>
  `${speaker}-${timestamp}`;

const compareUtterances = (left: Utterance, right: Utterance): number => {
  const timestampDiff = left.timestamp - right.timestamp;

  if (Math.abs(timestampDiff) <= QUEUE_CONFIG.timestampTieWindowMs) {
    if (left.speaker === right.speaker) {
      return timestampDiff;
    }

    return left.speaker === "them" ? -1 : 1;
  }

  return timestampDiff;
};

export class ConversationQueue {
  private readonly itemsById = new Map<string, Utterance>();

  create(input: CreateUtteranceInput): Utterance {
    const id = buildUtteranceId(input.speaker, input.timestamp);

    const utterance: Utterance = {
      id,
      speaker: input.speaker,
      timestamp: input.timestamp,
      status: "listening",
      originalText: "",
      translatedText: "",
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
    };

    this.itemsById.set(id, utterance);
    return utterance;
  }

  upsert(id: string, update: UpdateUtteranceInput): Utterance {
    const existing = this.itemsById.get(id);

    if (!existing) {
      throw new Error(`Unknown utterance id: ${id}`);
    }

    const merged: Utterance = {
      ...existing,
      ...update,
    };

    this.itemsById.set(id, merged);
    return merged;
  }

  markTimedOut(now: number): Utterance[] {
    const failed: Utterance[] = [];

    for (const item of this.itemsById.values()) {
      if (
        item.status === "listening" &&
        now - item.timestamp > QUEUE_CONFIG.listeningTimeoutMs
      ) {
        const updated: Utterance = {
          ...item,
          status: "failed",
        };

        this.itemsById.set(item.id, updated);
        failed.push(updated);
      }
    }

    return failed;
  }

  getOrdered(): Utterance[] {
    return [...this.itemsById.values()].sort(compareUtterances);
  }

  getById(id: string): Utterance | undefined {
    return this.itemsById.get(id);
  }

  clear(): void {
    this.itemsById.clear();
  }
}
