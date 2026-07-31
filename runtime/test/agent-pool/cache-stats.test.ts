import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@piclaw/agent-kernel";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

import { computePromptCacheWaste } from "../../src/agent-pool/cache-stats.js";

function assistant(options: {
  timestamp: number;
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputCost?: number;
  cacheReadCost?: number;
  model?: string;
}): AssistantMessage {
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  const inputCost = options.inputCost ?? 0;
  const cacheReadCost = options.cacheReadCost ?? 0;
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: options.model ?? "gpt-5.6",
    stopReason: "stop",
    timestamp: options.timestamp,
    usage: {
      input: options.input,
      output: 0,
      cacheRead,
      cacheWrite,
      totalTokens: options.input + cacheRead + cacheWrite,
      cost: {
        input: inputCost,
        output: 0,
        cacheRead: cacheReadCost,
        cacheWrite: 0,
        total: inputCost + cacheReadCost,
      },
    },
  } as AssistantMessage;
}

function messageEntry(message: AssistantMessage, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  } as SessionEntry;
}

const models = {
  find: () => ({ cost: { cacheRead: 0.1 } }),
} as unknown as ModelRegistry;

describe("computePromptCacheWaste", () => {
  test("counts prompt tokens re-billed instead of served from cache", () => {
    const entries = [
      messageEntry(assistant({ timestamp: 1_000, input: 0, cacheWrite: 10_000 }), "one"),
      messageEntry(assistant({ timestamp: 2_000, input: 8_000, cacheRead: 2_000, inputCost: 0.008, cacheReadCost: 0.0002 }), "two"),
    ];

    const waste = computePromptCacheWaste(entries, models);
    expect(waste.missCount).toBe(1);
    expect(waste.missedTokens).toBe(8_000);
    expect(waste.missedCost).toBeCloseTo(0.0072, 8);
  });

  test("ignores cache noise at or below 1024 tokens", () => {
    const entries = [
      messageEntry(assistant({ timestamp: 1_000, input: 0, cacheWrite: 10_000 }), "one"),
      messageEntry(assistant({ timestamp: 2_000, input: 1_000, cacheRead: 9_000, inputCost: 0.001, cacheReadCost: 0.0009 }), "two"),
    ];

    expect(computePromptCacheWaste(entries, models)).toEqual({
      missCount: 0,
      missedTokens: 0,
      missedCost: 0,
    });
  });

  test("counts prompt re-billing after a model switch", () => {
    const entries = [
      messageEntry(assistant({ timestamp: 1_000, input: 0, cacheWrite: 10_000, model: "gpt-5.4" }), "one"),
      messageEntry(assistant({ timestamp: 2_000, input: 10_000, inputCost: 0.01, model: "gpt-5.6" }), "two"),
    ];

    expect(computePromptCacheWaste(entries, models).missCount).toBe(1);
  });

  test("resets comparison after compaction", () => {
    const entries = [
      messageEntry(assistant({ timestamp: 1_000, input: 0, cacheWrite: 10_000 }), "one"),
      {
        type: "compaction",
        id: "compact",
        parentId: "one",
        timestamp: new Date(1_500).toISOString(),
        summary: "summary",
        firstKeptEntryId: "one",
        tokensBefore: 10_000,
      } as SessionEntry,
      messageEntry(assistant({ timestamp: 2_000, input: 10_000, inputCost: 0.01 }), "two"),
    ];

    expect(computePromptCacheWaste(entries, models).missCount).toBe(0);
  });
});
