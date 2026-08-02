/**
 * Subagent shared types.
 */
import type { ProfileOverrides } from "./profiles.ts";

export type SubagentType = "general-purpose" | "explore" | "plan" | "research" | "coding";

export interface AgentToolOptions {
  prompt: string;
  description: string;
  subagentType: SubagentType;
  model?: string;
  maxTurns?: number;
  runInBackground?: boolean;
  resume?: string;
  timeoutMs?: number;
  schedule?: string;
  timezone?: string | null;
  profileOverrides?: ProfileOverrides;
  signal?: AbortSignal;
  requireImmediateStart?: boolean;
}

export interface SubagentRunOutcome {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "stopped" | "running" | "queued" | "pending";
  summary: string;
  artifacts: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  error?: string;
  background?: boolean;
  usageEntries?: SubagentUsageEntry[];
}

export interface CodingSubagentResult {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "stopped";
  summary: string;
  artifacts: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  error?: string;
  usageEntries?: SubagentUsageEntry[];
}

export interface SubagentUsageEntry {
  invocationId: string;
  attempt: number;
  stage: "kernel" | "sandbox_worker" | "fallback";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: "success" | "failed" | "timed_out" | "stopped";
  /** True when runAgentSessionLoop already persisted each provider round. */
  realtimeLedger?: boolean;
}

export interface CodingSubagentOptions {
  task: string;
  timeoutMs?: number;
  constraints?: string;
  signal?: AbortSignal;
}
