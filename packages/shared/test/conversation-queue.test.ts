import { describe, expect, it } from "vitest";

import { ConversationQueue } from "../src/conversation-queue";
import type { Utterance } from "../src/types";

describe("ConversationQueue", () => {
  it("orders utterances by timestamp", () => {
    const queue = new ConversationQueue();

    queue.create({
      speaker: "you",
      timestamp: 200,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    queue.create({
      speaker: "them",
      timestamp: 100,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    const ordered = queue.getOrdered();
    expect(ordered.map((item: Utterance) => item.timestamp)).toEqual([
      100, 200,
    ]);
  });

  it("prefers them over you inside tie window", () => {
    const queue = new ConversationQueue();

    queue.create({
      speaker: "you",
      timestamp: 1000,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    queue.create({
      speaker: "them",
      timestamp: 1020,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    const ordered = queue.getOrdered();
    expect(ordered[0]?.speaker).toBe("them");
    expect(ordered[1]?.speaker).toBe("you");
  });

  it("marks listening utterances as failed after timeout", () => {
    const queue = new ConversationQueue();

    const created = queue.create({
      speaker: "you",
      timestamp: 100,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    const failed = queue.markTimedOut(6001);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe(created.id);
    expect(queue.getById(created.id)?.status).toBe("failed");
  });

  it("updates utterance fields without casts", () => {
    const queue = new ConversationQueue();

    const created = queue.create({
      speaker: "them",
      timestamp: 500,
      sourceLang: "en-US",
      targetLang: "hi-IN",
    });

    const updated = queue.upsert(created.id, {
      status: "processing",
      originalText: "hello there",
    });

    expect(updated.status).toBe("processing");
    expect(updated.originalText).toBe("hello there");
  });
});
