/**
 * Subagent type profiles — config-driven tool/mode/prompt settings (pi-subagents parity).
 */
import { config } from "../config.ts";
import { getDispatchMcpTools } from "../tools/dispatcher.ts";
import { getToolDefinitionsForMode } from "../tools/schemas.ts";
import { CODING_TOOL_DEFINITIONS } from "../tools/coding-schemas.ts";
import type { ToolDefinition } from "../tools/schemas.ts";
import type { SubagentType } from "./types.ts";

export type PromptMode = "replace" | "append";

export interface SubagentProfile {
  agentType: SubagentType;
  mode: "plan" | "execute";
  promptMode: PromptMode;
  systemPrompt: string;
  maxTurns: number;
  resolveTools: (sessionId: string) => Promise<ToolDefinition[]>;
}

const EXPLORE_PROMPT =
  "You are an explore subagent. Investigate the codebase read-only using read/bash/question. Summarize findings.";
const PLAN_PROMPT =
  "You are a planning subagent. Produce a clear implementation plan. Use read/bash(readonly)/question/todo only. Do not modify files.";
const CODING_PROMPT = [
  "You are a coding subagent working in /workspace inside an isolated sandbox.",
  "Use bash, read, write, and edit tools to complete the task.",
  "When done, respond with a concise summary of what you changed.",
].join("\n");

async function planTools(_sessionId: string): Promise<ToolDefinition[]> {
  const mcpTools = await getDispatchMcpTools();
  return getToolDefinitionsForMode("plan", mcpTools);
}

async function codingTools(_sessionId: string): Promise<ToolDefinition[]> {
  void _sessionId;
  return CODING_TOOL_DEFINITIONS;
}

const BASE_PROFILES: Record<Exclude<SubagentType, "coding">, SubagentProfile> = {
  explore: {
    agentType: "explore",
    mode: "plan",
    promptMode: "replace",
    systemPrompt: EXPLORE_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: planTools,
  },
  plan: {
    agentType: "plan",
    mode: "plan",
    promptMode: "replace",
    systemPrompt: PLAN_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: planTools,
  },
  "general-purpose": {
    agentType: "general-purpose",
    mode: "execute",
    promptMode: "append",
    systemPrompt: CODING_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: codingTools,
  },
};

export interface ProfileOverrides {
  systemPrompt?: string;
  mode?: "plan" | "execute";
  promptMode?: PromptMode;
  maxTurns?: number;
  toolNames?: string[];
}

export async function resolveSubagentProfile(
  agentType: SubagentType,
  sessionId: string,
  overrides: ProfileOverrides = {},
): Promise<SubagentProfile> {
  const base =
    agentType === "coding"
      ? {
          agentType: "general-purpose" as const,
          mode: "execute" as const,
          promptMode: "append" as const,
          systemPrompt: CODING_PROMPT,
          maxTurns: config.subagentMaxTurns,
          resolveTools: codingTools,
        }
      : BASE_PROFILES[agentType];

  const tools = overrides.toolNames?.length
    ? (await base.resolveTools(sessionId)).filter((tool) => overrides.toolNames!.includes(tool.function.name))
    : await base.resolveTools(sessionId);

  return {
    ...base,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
    mode: overrides.mode ?? base.mode,
    promptMode: overrides.promptMode ?? base.promptMode,
    maxTurns: overrides.maxTurns ?? base.maxTurns,
    resolveTools: async () => tools,
  };
}

export function buildSubagentUserPrompt(
  profile: SubagentProfile,
  task: string,
  constraints?: string,
  parentSystemAppend?: string,
): string {
  const taskBlock = constraints ? `${task}\n\nConstraints:\n${constraints}` : task;
  if (profile.promptMode === "append" && parentSystemAppend) {
    return `${parentSystemAppend}\n\nTask:\n${taskBlock}`;
  }
  return taskBlock;
}
