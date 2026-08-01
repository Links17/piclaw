import type { MessageRow } from "@piclaw-cloud/store";
import type { SessionMode } from "@piclaw-cloud/store";

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ContentBlocks {
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  user_message_id?: number;
  turn_operation_id?: string;
}

export const BASE_SYSTEM_PROMPT = `You are PiClaw, a coding assistant running in a remote sandbox.
Working directory: /workspace
Tool discovery is staged to save context. Before using an optional capability, call list_tools with a focused request, then activate_tools with the exact tool name(s) you need. In particular, activate coding_agent before delegating coding work, and activate bash/read/write/edit before direct sandbox operations.
For creating or modifying code/files, prefer the Agent tool (subagent_type=general-purpose) to delegate work to an isolated coding worker in the sandbox; the worker returns a summary and artifacts without filling your context with every tool step.
Use bash, read, write, and edit directly only for quick one-off checks — never to duplicate work after a successful Agent result, and never as a substitute when Agent fails (ask the user or retry Agent instead).
When requirements are ambiguous, use the question tool with clear options instead of guessing. Call the question tool at most once per user message; if the user does not answer, proceed with reasonable defaults.
For multi-step tasks, create todos with the todo tool and toggle them as you progress.
When modifying existing files via direct tools, read them first if needed, then use edit with a unique old_string match.
Answer concisely after completing the requested work.`;

export const PLAN_MODE_PROMPT = `You are in PLAN mode. Produce a clear implementation plan only.
Use read, bash (read-only inspection), question, and todo tools. Do not write or edit files.
Output the plan as structured markdown. Wait for user confirmation before execution.`;

export function buildSystemPrompt(options: {
  mode: SessionMode;
  skillsSection?: string;
  planText?: string;
}): string {
  const parts = [BASE_SYSTEM_PROMPT];
  if (options.mode === "plan") parts.push(PLAN_MODE_PROMPT);
  if (options.skillsSection?.trim()) parts.push(options.skillsSection.trim());
  if (options.planText?.trim()) {
    parts.push(`Current approved plan:\n${options.planText.trim()}`);
  }
  return parts.join("\n\n");
}

export function historyToOpenAi(
  rows: MessageRow[],
  options: { mode?: SessionMode; skillsSection?: string; planText?: string } = {},
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        mode: options.mode ?? "execute",
        skillsSection: options.skillsSection,
        planText: options.planText,
      }),
    },
  ];
  for (const row of rows) {
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content });
      continue;
    }
    if (row.role === "assistant") {
      const blocks = row.content_blocks as ContentBlocks | null;
      const toolCalls = blocks?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: row.content || null,
          tool_calls: toolCalls,
        });
      } else if (row.content) {
        messages.push({ role: "assistant", content: row.content });
      }
      continue;
    }
    if (row.role === "tool") {
      const blocks = row.content_blocks as ContentBlocks | null;
      const toolCallId = blocks?.tool_call_id ?? "unknown";
      messages.push({ role: "tool", tool_call_id: toolCallId, content: row.content });
    }
  }
  return messages;
}

export function assistantToolCallBlocks(toolCalls: OpenAiToolCall[]): ContentBlocks {
  return { tool_calls: toolCalls };
}

export function toolResultBlocks(toolCallId: string, name: string): ContentBlocks {
  return { tool_call_id: toolCallId, tool_name: name };
}

/** @deprecated Use buildSystemPrompt — kept for tests. */
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;
