import type { SubagentRunOutcome, SubagentUsageEntry } from "./types.ts";
import type { LlmUsage } from "../llm.ts";

export function realtimeKernelUsageEntry(
  invocationId: string,
  usage: LlmUsage,
  model = "coding-agent",
): SubagentUsageEntry {
  return {
    invocationId,
    attempt: 1,
    stage: "fallback",
    provider: "cloud-kernel",
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cacheReadTokens: usage.cachedTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    status: "success",
    realtimeLedger: true,
  };
}

export function usageEntriesForSubagentOutcome(
  runId: string,
  outcome: SubagentRunOutcome,
): Array<SubagentUsageEntry & { usageKey: string }> {
  const entries = outcome.usageEntries ?? [{
    invocationId: runId,
    attempt: 1,
    stage: "kernel" as const,
    provider: "cloud-kernel",
    model: "coding-agent",
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    status: outcome.status === "completed"
      ? "success" as const
      : outcome.status === "timed_out"
        ? "timed_out" as const
        : outcome.status === "stopped"
          ? "stopped" as const
          : "failed" as const,
  }];
  return entries.map((entry) => ({
    ...entry,
    usageKey: `subagent:${runId}:${entry.invocationId}:${entry.attempt}:${entry.stage}`,
  }));
}
