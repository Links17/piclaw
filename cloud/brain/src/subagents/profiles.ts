/**
 * Subagent type profiles — config-driven tool/mode/prompt settings (pi-subagents parity).
 */
import { config } from "../config.ts";
import { getDispatchMcpTools } from "../tools/dispatcher.ts";
import { getToolDefinitionsForMode } from "../tools/schemas.ts";
import { CODING_TOOL_DEFINITIONS } from "../tools/coding-schemas.ts";
import type { ToolDefinition } from "../tools/schemas.ts";
import type { AgentExecutionBackend } from "./invocation.ts";
import type { SubagentType } from "./types.ts";

export type PromptMode = "replace" | "append";

export interface SubagentProfile {
  agentType: SubagentType;
  executionBackend: AgentExecutionBackend;
  runner: "kernel" | "coding-worker";
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
const RESEARCH_PROMPT = [
  "You are a research subagent running without a coding sandbox.",
  "Use only the service and remote capabilities exposed to you.",
  "Gather evidence, compare sources, and return a concise structured summary.",
].join("\n");
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

export function filterServiceToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  const allowed = new Set(["question", "skill", "todo"]);
  return tools.filter((tool) =>
    allowed.has(tool.function.name) || tool.function.name.startsWith("mcp__")
  );
}

async function serviceTools(_sessionId: string): Promise<ToolDefinition[]> {
  const mcpTools = await getDispatchMcpTools();
  const tools = filterServiceToolDefinitions([
    ...getToolDefinitionsForMode("plan"),
    ...mcpTools,
  ]);
  return tools.filter((tool) =>
    !tool.function.name.startsWith("mcp__")
      || /^mcp__[^_]+__(web_search|web_search_advanced|fetch_content|source_check)/.test(tool.function.name)
  );
}

const BASE_PROFILES: Record<Exclude<SubagentType, "coding">, SubagentProfile> = {
  explore: {
    agentType: "explore",
    executionBackend: "sandbox",
    runner: "kernel",
    mode: "plan",
    promptMode: "replace",
    systemPrompt: EXPLORE_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: planTools,
  },
  plan: {
    agentType: "plan",
    executionBackend: "sandbox",
    runner: "kernel",
    mode: "plan",
    promptMode: "replace",
    systemPrompt: PLAN_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: planTools,
  },
  research: {
    agentType: "research",
    executionBackend: "service",
    runner: "kernel",
    mode: "plan",
    promptMode: "replace",
    systemPrompt: RESEARCH_PROMPT,
    maxTurns: config.subagentMaxTurns,
    resolveTools: serviceTools,
  },
  "general-purpose": {
    agentType: "general-purpose",
    executionBackend: "sandbox",
    runner: "coding-worker",
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
          executionBackend: "sandbox" as const,
          runner: "coding-worker" as const,
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
