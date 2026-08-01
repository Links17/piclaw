import type { ContextUsageSnapshot } from "./agent-run-state.ts";
import type { SessionContextSnapshot, SessionTokenUsage } from "@piclaw-cloud/store";
import { estimateContextTokens, type AgentMessage } from "./kernel/pi.ts";

export function buildEstimatedContextSnapshot(input: {
  messages: AgentMessage[];
  contextWindow: number;
  model: string;
  provider: string;
  throughMessageId: number;
  latestMessageId: number;
  compactedThroughMessageId: number;
  updatedAt?: string;
}): ContextUsageSnapshot {
  const tokens = estimateContextTokens(input.messages).tokens;
  return {
    tokens,
    contextWindow: input.contextWindow,
    percent: Math.min(100, Math.round((tokens / input.contextWindow) * 100)),
    model: input.model,
    provider: input.provider,
    throughMessageId: input.throughMessageId,
    latestMessageId: input.latestMessageId,
    compactedThroughMessageId: input.compactedThroughMessageId,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

function persistedToContext(snapshot: SessionContextSnapshot): ContextUsageSnapshot {
  return {
    tokens: snapshot.usedTokens,
    contextWindow: snapshot.contextWindow,
    percent: Math.min(100, Math.round((snapshot.usedTokens / snapshot.contextWindow) * 100)),
    model: snapshot.model,
    provider: snapshot.provider,
    throughMessageId: snapshot.throughMessageId,
    latestMessageId: snapshot.latestMessageId,
    compactedThroughMessageId: snapshot.compactedThroughMessageId,
    updatedAt: snapshot.updatedAt,
  };
}

export function isContextSnapshotFresh(
  snapshot: SessionContextSnapshot,
  latestMessageId: number,
  compactedThroughMessageId: number,
): boolean {
  return snapshot.latestMessageId >= latestMessageId
    && snapshot.compactedThroughMessageId >= compactedThroughMessageId;
}

export function resolveContextSnapshot(input: {
  persisted: SessionContextSnapshot | null;
  local: ContextUsageSnapshot | null;
}): ContextUsageSnapshot | null {
  if (!input.persisted) return input.local;
  if (!input.local) return persistedToContext(input.persisted);
  const persistedUpdatedAt = Date.parse(input.persisted.updatedAt);
  const localUpdatedAt = Date.parse(input.local.updatedAt);
  if (
    input.local.throughMessageId > input.persisted.throughMessageId
    || (
      input.local.throughMessageId === input.persisted.throughMessageId
      && (
        input.local.latestMessageId > input.persisted.latestMessageId
        || (
          input.local.latestMessageId === input.persisted.latestMessageId
          && input.local.compactedThroughMessageId >= input.persisted.compactedThroughMessageId
          && localUpdatedAt > persistedUpdatedAt
        )
      )
    )
  ) {
    return input.local;
  }
  return persistedToContext(input.persisted);
}

export function buildContextUsagePayload(input: {
  context: ContextUsageSnapshot | null;
  fallbackContextWindow?: number | null;
  daily: { inputTokens: number; outputTokens: number; totalTokens: number };
  dailyLimit: number;
  sessionUsage: SessionTokenUsage;
}) {
  const contextTotal = input.context?.contextWindow ?? input.fallbackContextWindow ?? null;
  const contextUsed = input.context?.tokens ?? null;
  const contextPercent = input.context?.percent ?? null;
  const dailyTotal = Math.max(0, input.dailyLimit);
  const dailyUsed = input.daily.totalTokens;
  return {
    tokens: contextUsed,
    context_window: contextTotal,
    contextWindow: contextTotal,
    percent: contextPercent,
    context: {
      used: contextUsed,
      total: contextTotal,
      remaining: contextTotal == null || contextUsed == null
        ? null
        : Math.max(0, contextTotal - contextUsed),
      percent: contextPercent,
      kind: "occupancy_estimate",
      model: input.context?.model ?? null,
      provider: input.context?.provider ?? null,
      updatedAt: input.context?.updatedAt ?? null,
      throughMessageId: input.context?.throughMessageId ?? null,
      latestMessageId: input.context?.latestMessageId ?? null,
      compactedThroughMessageId: input.context?.compactedThroughMessageId ?? null,
    },
    dailyQuota: {
      used: dailyUsed,
      total: dailyTotal,
      remaining: Math.max(0, dailyTotal - dailyUsed),
      percent: dailyTotal > 0 ? Math.min(100, Math.round((dailyUsed / dailyTotal) * 100)) : 0,
      inputTokens: input.daily.inputTokens,
      outputTokens: input.daily.outputTokens,
      kind: "billed_usage",
    },
    sessionUsage: {
      ...input.sessionUsage,
      kind: "billed_usage",
    },
    cacheUsage: {
      latest: input.sessionUsage.latest,
      totals: input.sessionUsage.totals,
    },
  };
}
