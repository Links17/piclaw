/**
 * Bridge pi-ai Context ↔ legacy mock completion rounds for kernel mock runtime.
 */
import type { Context, TextContent, ImageContent } from "../kernel/pi.ts";
import type { OpenAiMessage, OpenAiToolCall } from "./messages.ts";
import { streamCompletionRound, type CompletionRound, type StreamCompletionOptions } from "../llm.ts";
import { TOOL_DEFINITIONS } from "../tools/schemas.ts";

type ContentBlock = TextContent | ImageContent;

function blocksToText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function contextToOpenAiMessages(context: Context): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: "system", content: context.systemPrompt.trim() });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: blocksToText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls: OpenAiToolCall[] = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          },
        }));
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: blocksToText(message.content),
      });
    }
  }
  return messages;
}

export async function resolveMockCompletionForContext(
  context: Context,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  const messages = contextToOpenAiMessages(context);
  return streamCompletionRound(messages, async () => {}, TOOL_DEFINITIONS, options);
}
