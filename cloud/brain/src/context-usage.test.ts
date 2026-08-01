import { describe, expect, test } from "bun:test";
import {
  buildEstimatedContextSnapshot,
  buildContextUsagePayload,
  isContextSnapshotFresh,
  resolveContextSnapshot,
} from "./context-usage.ts";

describe("buildContextUsagePayload", () => {
  test("returns context, daily quota, session totals, latest, and source breakdown", () => {
    const payload = buildContextUsagePayload({
      context: {
        tokens: 80_000,
        contextWindow: 128_000,
        percent: 63,
        model: "openai/test",
        provider: "openai",
        throughMessageId: 10,
        latestMessageId: 10,
        compactedThroughMessageId: 0,
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
      daily: { inputTokens: 120_000, outputTokens: 30_000, totalTokens: 150_000 },
      dailyLimit: 500_000,
      sessionUsage: {
        totals: {
          inputTokens: 100_000,
          outputTokens: 25_000,
          reasoningTokens: 0,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 2_000,
          totalTokens: 125_000,
          runs: 4,
        },
        latest: null,
        bySource: {
          assistant: {
            inputTokens: 90_000,
            outputTokens: 20_000,
            reasoningTokens: 0,
            cacheReadTokens: 50_000,
            cacheWriteTokens: 2_000,
            totalTokens: 110_000,
            runs: 3,
          },
        },
      },
    });

    expect(payload.context).toMatchObject({
      used: 80_000,
      total: 128_000,
      remaining: 48_000,
      percent: 63,
    });
    expect(payload.dailyQuota).toMatchObject({
      used: 150_000,
      total: 500_000,
      remaining: 350_000,
      percent: 30,
      inputTokens: 120_000,
      outputTokens: 30_000,
    });
    expect(payload.sessionUsage.totals.cacheReadTokens).toBe(50_000);
    expect(payload.cacheUsage.totals).toEqual(payload.sessionUsage.totals);
    expect(payload.tokens).toBe(80_000);
    expect(payload.context_window).toBe(128_000);
  });

  test("labels occupancy separately from billed usage and exposes snapshot metadata", () => {
    const payload = buildContextUsagePayload({
      context: {
        tokens: 10_000,
        contextWindow: 64_000,
        percent: 16,
        model: "provider/model-a",
        provider: "provider",
        updatedAt: "2026-08-01T10:00:00.000Z",
        throughMessageId: 20,
        latestMessageId: 23,
        compactedThroughMessageId: 10,
      },
      daily: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      dailyLimit: 1_000,
      sessionUsage: {
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          runs: 0,
        },
        latest: null,
        bySource: {},
      },
    });

    expect(payload.context).toMatchObject({
      used: 10_000,
      total: 64_000,
      kind: "occupancy_estimate",
      model: "provider/model-a",
      provider: "provider",
      throughMessageId: 20,
      latestMessageId: 23,
      compactedThroughMessageId: 10,
    });
    expect(payload.sessionUsage.kind).toBe("billed_usage");
    expect(payload.dailyQuota.kind).toBe("billed_usage");
  });
});

describe("resolveContextSnapshot", () => {
  const persisted = {
    sessionId: "session-a",
    userId: "user-a",
    usedTokens: 5_000,
    contextWindow: 32_000,
    model: "provider/model",
    provider: "provider",
    throughMessageId: 9,
    latestMessageId: 11,
    compactedThroughMessageId: 4,
    updatedAt: "2026-08-01T10:00:00.000Z",
  };

  test("prefers a newer local value without making replica memory authoritative", () => {
    expect(resolveContextSnapshot({
      persisted,
      local: {
        tokens: 6_000,
        contextWindow: 32_000,
        percent: 19,
        model: "provider/model",
        provider: "provider",
        throughMessageId: 9,
        latestMessageId: 12,
        compactedThroughMessageId: 4,
        updatedAt: "2026-08-01T10:00:01.000Z",
      },
    })?.tokens).toBe(6_000);
    expect(resolveContextSnapshot({ persisted, local: null })?.tokens).toBe(5_000);
  });

  test("treats a snapshot behind the requested latest boundary as stale", () => {
    expect(isContextSnapshotFresh(persisted, 11, 4)).toBe(true);
    expect(isContextSnapshotFresh(persisted, 12, 4)).toBe(false);
    expect(isContextSnapshotFresh(persisted, 11, 5)).toBe(false);
  });

  test("estimates an idle session with its resolved model window and boundary", () => {
    const snapshot = buildEstimatedContextSnapshot({
      messages: [{ role: "user", content: "small idle history", timestamp: 1 }],
      contextWindow: 200_000,
      model: "anthropic/idle-model",
      provider: "anthropic",
      throughMessageId: 30,
      latestMessageId: 30,
      compactedThroughMessageId: 0,
      updatedAt: "2026-08-01T11:00:00.000Z",
    });

    expect(snapshot.contextWindow).toBe(200_000);
    expect(snapshot.model).toBe("anthropic/idle-model");
    expect(snapshot.provider).toBe("anthropic");
    expect(snapshot.throughMessageId).toBe(30);
    expect(snapshot.compactedThroughMessageId).toBe(0);
    expect(snapshot.tokens).toBeGreaterThan(0);
  });
});
