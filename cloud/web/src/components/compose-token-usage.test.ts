import { describe, expect, test } from "bun:test";
import { resolveComposeTokenUsageMeta } from "./token-usage-meta.ts";

describe("resolveComposeTokenUsageMeta", () => {
  test("formats context, daily quota, session usage, and source details", () => {
    const meta = resolveComposeTokenUsageMeta({
      context: { used: 82_000, total: 128_000, percent: 64 },
      dailyQuota: { used: 214_000, total: 500_000, percent: 43 },
      sessionUsage: {
        totals: {
          inputTokens: 120_000,
          outputTokens: 31_000,
          cacheReadTokens: 63_000,
          cacheWriteTokens: 4_000,
          totalTokens: 151_000,
          runs: 8,
        },
        bySource: {
          assistant: { totalTokens: 100_000 },
          side_prompt: { totalTokens: 10_000 },
          subagent: { totalTokens: 30_000 },
          compaction: { totalTokens: 11_000 },
        },
      },
    });

    expect(meta?.label).toContain("Context 82K / 128K · 64%");
    expect(meta?.label).toContain("Daily 214K / 500K · 43%");
    expect(meta?.label).toContain("In 120K");
    expect(meta?.label).toContain("Cache R 63K");
    expect(meta?.title).toContain("Main Agent: 100K");
    expect(meta?.title).toContain("Compaction: 11K");
  });
});
