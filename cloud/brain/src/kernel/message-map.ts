import type { MessageRow } from "@piclaw-cloud/store";
import {
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type Usage,
} from "./pi.ts";
import { CLOUD_KERNEL_PROVIDER_ID } from "./provider.ts";
import { compactToolResultText } from "./smart-compaction.ts";
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

export function rowsToAgentMessages(
  rows: MessageRow[],
  modelName: string,
  options: {
    toolResultMaxChars?: number;
    toolResultCompactionTools?: string[];
  } = {},
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const compactableTools = new Set(
    (options.toolResultCompactionTools ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const row of rows) {
    const timestamp = Number.isFinite(Date.parse(row.created_at))
      ? Date.parse(row.created_at)
      : Date.now();
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content, timestamp });
      continue;
    }
    if (row.role === "system") {
      const blocks = row.content_blocks as { kind?: unknown; tokens_before?: unknown } | null;
      if (blocks?.kind === "compaction_summary") {
        messages.push({
          role: "compactionSummary",
          summary: row.content,
          tokensBefore: Number(blocks.tokens_before ?? 0),
          timestamp,
        });
      }
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
      const toolName = blocks?.tool_name ?? "unknown";
      const content = options.toolResultMaxChars != null
        && compactableTools.has(toolName.trim().toLowerCase())
        ? compactToolResultText(row.content, { maxChars: options.toolResultMaxChars })
        : row.content;
      messages.push({
        role: "toolResult",
        toolCallId: blocks?.tool_call_id ?? "unknown",
        toolName,
        content: [{ type: "text", text: content }],
        isError: false,
        timestamp,
      });
    }
  }
  return trimLeadingOrphanToolResults(messages);
}

export function assistantMessageToRow(
  message: AssistantMessage,
  receiptContext?: { userMessageId: number; operationId: string; attempt: number },
): {
  content: string;
  contentBlocks?: unknown;
} {
  const toolCalls = message.content.filter((block) => block.type === "toolCall");
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const usageReceipt = {
    version: 1,
    user_message_id: receiptContext?.userMessageId,
    operation_id: receiptContext?.operationId,
    attempt: receiptContext?.attempt,
    provider: message.provider,
    model: message.model,
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    reasoning_tokens: Number((message.usage as Usage & { reasoning?: number }).reasoning ?? 0),
    cache_read_tokens: message.usage.cacheRead,
    cache_write_tokens: message.usage.cacheWrite,
    status: message.stopReason === "aborted"
      ? "aborted"
      : message.stopReason === "error"
        ? "error"
        : "success",
  };
  if (toolCalls.length === 0) {
    return {
      content: text,
      contentBlocks: {
        user_message_id: receiptContext?.userMessageId,
        turn_operation_id: receiptContext?.operationId,
        usage_receipt: usageReceipt,
      },
    };
  }
  const openAiCalls: OpenAiToolCall[] = toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
  return {
    content: text,
    contentBlocks: {
      ...assistantToolCallBlocks(openAiCalls),
      user_message_id: receiptContext?.userMessageId,
      turn_operation_id: receiptContext?.operationId,
      usage_receipt: usageReceipt,
    },
  };
}

export function toolResultMessageToRow(
  message: ToolResultMessage,
  turnContext?: { userMessageId: number; operationId: string },
): {
  content: string;
  contentBlocks: unknown;
} {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    content: text,
    contentBlocks: {
      ...toolResultBlocks(message.toolCallId, message.toolName),
      user_message_id: turnContext?.userMessageId,
      turn_operation_id: turnContext?.operationId,
    },
  };
}

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
