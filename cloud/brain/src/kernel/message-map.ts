import type { MessageRow } from "@piclaw-cloud/store";
import {
  CLOUD_KERNEL_PROVIDER_ID,
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type Usage,
} from "@piclaw/agent-kernel";
import {
  assistantToolCallBlocks,
  toolResultBlocks,
  type ContentBlocks,
  type OpenAiToolCall,
} from "../llm/messages.ts";

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Drop leading tool results whose assistant tool-call message was truncated away. */
export function trimLeadingOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "toolResult") {
    index += 1;
  }
  return index === 0 ? messages : messages.slice(index);
}

export function rowsToAgentMessages(rows: MessageRow[], modelName: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const row of rows) {
    const timestamp = Number.isFinite(Date.parse(row.created_at))
      ? Date.parse(row.created_at)
      : Date.now();
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content, timestamp });
      continue;
    }
    if (row.role === "system") {
      continue;
    }
    if (row.role === "assistant") {
      const blocks = row.content_blocks as ContentBlocks | null;
      const toolCalls = blocks?.tool_calls ?? [];
      const content: AssistantMessage["content"] =
        toolCalls.length > 0
          ? [
              ...(row.content ? [{ type: "text" as const, text: row.content }] : []),
              ...toolCalls.map((call) => ({
                type: "toolCall" as const,
                id: call.id,
                name: call.function.name,
                arguments: parseToolArguments(call.function.arguments),
              })),
            ]
          : [{ type: "text" as const, text: row.content }];
      messages.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: CLOUD_KERNEL_PROVIDER_ID,
        model: modelName,
        usage: emptyUsage(),
        stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp,
      });
      continue;
    }
    if (row.role === "tool") {
      const blocks = row.content_blocks as ContentBlocks | null;
      messages.push({
        role: "toolResult",
        toolCallId: blocks?.tool_call_id ?? "unknown",
        toolName: blocks?.tool_name ?? "unknown",
        content: [{ type: "text", text: row.content }],
        isError: false,
        timestamp,
      });
    }
  }
  return trimLeadingOrphanToolResults(messages);
}

export function assistantMessageToRow(message: AssistantMessage): {
  content: string;
  contentBlocks?: unknown;
} {
  const toolCalls = message.content.filter((block) => block.type === "toolCall");
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (toolCalls.length === 0) {
    return { content: text };
  }
  const openAiCalls: OpenAiToolCall[] = toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
  return { content: text, contentBlocks: assistantToolCallBlocks(openAiCalls) };
}

export function toolResultMessageToRow(message: ToolResultMessage): {
  content: string;
  contentBlocks: unknown;
} {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    content: text,
    contentBlocks: toolResultBlocks(message.toolCallId, message.toolName),
  };
}

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
