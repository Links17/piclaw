/**
 * Subagent shared types.
 */
import type { ProfileOverrides } from "./profiles.ts";

export type SubagentType = "general-purpose" | "explore" | "plan" | "coding";

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
  profileOverrides?: ProfileOverrides;
}

export interface SubagentRunOutcome {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "stopped" | "running" | "queued" | "pending";
  summary: string;
  artifacts: string[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
  background?: boolean;
}

export interface CodingSubagentResult {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "stopped";
  summary: string;
  artifacts: string[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface CodingSubagentOptions {
  task: string;
  timeoutMs?: number;
  constraints?: string;
}
