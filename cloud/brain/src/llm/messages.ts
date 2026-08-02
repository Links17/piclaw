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

export const BASE_SYSTEM_PROMPT = `You are PiClaw, the user-facing orchestrator for a system of specialized agents and workflows.
Working directory: /workspace
Understand intent, clarify missing requirements, select an agent profile or workflow, dispatch the work, and summarize the result. Do not absorb business work that needs its own context, permissions, retries, accounting, or lifecycle.
Tool discovery is staged to save context. Before using an optional capability, call list_tools with a focused request, then activate_tools with the exact tool name(s) you need. The Agent and scheduled_tasks orchestration tools are already available in execute mode; activate bash/read/write/edit only for direct sandbox operations.
Delegate with Agent when work depends on repository context, spans multiple files, requires testing or several tool rounds, performs research, or should run in the background. Use scheduled_tasks for persistent future or recurring agent work. Use general-purpose for sandbox coding and research/explore/plan for service execution without a coding sandbox.
Answer directly or use direct tools for a short self-contained response or a trivial exact change that can be completed safely in one or two tool calls. Never duplicate work after a successful Agent result.
Scheduled work is a persistent side effect. Do not claim that scheduled work was created until scheduled_tasks returns confirmed=true and a real task id. You must not claim scheduling is unavailable unless scheduled_tasks returns an error. Discussion about reminders or scheduling must not create work.
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
  timezone?: string | null;
}): string {
  const parts = [BASE_SYSTEM_PROMPT];
  parts.push(options.timezone
    ? `Saved user timezone: ${options.timezone}. A timezone explicitly stated in the current request takes precedence.`
    : "No saved user timezone is available. If a date or wall-clock time depends on timezone, ask with the question tool before creating timezone-sensitive work.");
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
