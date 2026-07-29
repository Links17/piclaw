import type { MessageRow } from "@piclaw-cloud/store";

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
}

export const SYSTEM_PROMPT = `You are PiClaw, a coding assistant running in a remote sandbox.
Working directory: /workspace
For creating or modifying code/files, prefer the coding_agent tool to delegate work to an isolated coding worker in the sandbox; the worker returns a summary and artifacts without filling your context with every tool step.
Use bash, read, write, and edit directly only for quick one-off checks — never to duplicate work after a successful coding_agent result, and never as a substitute when coding_agent fails (ask the user or retry coding_agent instead).
When modifying existing files via direct tools, read them first if needed, then use edit with a unique old_string match.
Answer concisely after completing the requested work.`;

export function historyToOpenAi(rows: MessageRow[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
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
