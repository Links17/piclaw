/**
 * LLM adapter — streaming completion with optional function-calling tool loop support.
 */
import { config } from "./config.ts";
import {
  applyStreamChunk,
  createStreamAccumulator,
  finalizeStreamAccumulator,
  type ParsedToolCall,
} from "./llm/stream-parser.ts";
import type { OpenAiMessage } from "./llm/messages.ts";
import { TOOL_DEFINITIONS } from "./tools/schemas.ts";

export interface LlmUsage {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
}

export interface CompletionRound {
  text: string;
  toolCalls: ParsedToolCall[];
  finishReason: string | null;
  usage: LlmUsage;
}

export async function streamCompletionRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
): Promise<CompletionRound> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser && "content" in lastUser ? String(lastUser.content ?? "") : "";
  if (prompt.startsWith("mock-tools:")) {
    return streamMockRound(messages, onDelta, prompt);
  }
  if (prompt.startsWith("mock-coding:")) {
    return streamMockRound(messages, onDelta, prompt);
  }
  if (config.openaiBaseUrl && config.openaiApiKey) {
    return streamOpenAiRound(messages, onDelta);
  }
  return streamMockRound(messages, onDelta, prompt);
}

/** Legacy single-shot completion for infra scenarios without tools. */
export async function streamCompletion(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
): Promise<{ text: string; usage: LlmUsage }> {
  const round = await streamCompletionRound(messages, onDelta);
  return { text: round.text, usage: round.usage };
}

async function streamMockRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  promptOverride?: string,
): Promise<CompletionRound> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = promptOverride ?? (lastUser && "content" in lastUser ? String(lastUser.content ?? "") : "");

  // Deterministic tool-loop mock for integration tests.
  if (prompt.startsWith("mock-tools:")) {
    return mockToolsRound(messages, onDelta, prompt);
  }
  if (prompt.startsWith("mock-coding:")) {
    return mockCodingRound(messages, onDelta, prompt);
  }

  let tokens = 8;
  let delayMs = 30;
  if (prompt.startsWith("slow")) {
    tokens = 40;
    delayMs = 500;
  } else if (prompt.startsWith("medium")) {
    tokens = 20;
    delayMs = 150;
  }

  const parts: string[] = [];
  for (let i = 0; i < tokens; i += 1) {
    const piece = i === 0 ? `mock-reply(to: ${prompt.slice(0, 24)})` : ` t${i}`;
    parts.push(piece);
    await onDelta(piece);
    await Bun.sleep(delayMs);
  }
  return {
    text: parts.join(""),
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: null, cachedTokens: null, outputTokens: tokens },
  };
}

async function mockToolsRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  prompt: string,
): Promise<CompletionRound> {
  const hasToolResults = messages.some((m) => m.role === "tool");
  const hasAssistantTools = messages.some(
    (m) => m.role === "assistant" && "tool_calls" in m && (m.tool_calls?.length ?? 0) > 0,
  );

  if (!hasAssistantTools) {
    if (prompt.includes("coding_agent") || prompt.includes("coding-agent")) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call_mock_coding_agent",
            name: "coding_agent",
            arguments: JSON.stringify({
              task: "mock-coding:create demo.ino hello world sketch",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      };
    }
    if (prompt.includes("edit")) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call_mock_edit",
            name: "edit",
            arguments: JSON.stringify({
              path: "/workspace/demo.ino",
              old_string: "hello world",
              new_string: "hello agent",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      };
    }
    return {
      text: "",
      toolCalls: [
        {
          id: "call_mock_write",
          name: "write",
          arguments: JSON.stringify({
            path: "/workspace/demo.ino",
            content: "void setup() {}\nvoid loop() { Serial.println(\"hello world\"); }\n",
          }),
        },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
    };
  }

  if (hasToolResults) {
    const text = prompt.includes("edit") ? "Updated the demo to hello agent." : "Created the hello world demo.";
    await onDelta(text);
    return {
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: text.length },
    };
  }

  return { text: "", toolCalls: [], finishReason: "stop", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } };
}

async function mockCodingRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  prompt: string,
): Promise<CompletionRound> {
  const hasToolResults = messages.some((m) => m.role === "tool");
  const hasAssistantTools = messages.some(
    (m) => m.role === "assistant" && "tool_calls" in m && (m.tool_calls?.length ?? 0) > 0,
  );

  if (!hasAssistantTools) {
    if (prompt.includes("edit")) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call_coding_edit",
            name: "edit",
            arguments: JSON.stringify({
              path: "/workspace/demo.ino",
              old_string: "hello world",
              new_string: "hello agent",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      };
    }
    return {
      text: "",
      toolCalls: [
        {
          id: "call_coding_write",
          name: "write",
          arguments: JSON.stringify({
            path: "/workspace/demo.ino",
            content: "void setup() {}\nvoid loop() { Serial.println(\"hello world\"); }\n",
          }),
        },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
    };
  }

  if (hasToolResults) {
    const text = prompt.includes("edit")
      ? "Updated demo.ino to hello agent."
      : "Created demo.ino with hello world sketch.";
    await onDelta(text);
    return {
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: text.length },
    };
  }

  return { text: "", toolCalls: [], finishReason: "stop", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } };
}

async function streamOpenAiRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
): Promise<CompletionRound> {
  const response = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`LLM HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const acc = createStreamAccumulator();
  const usage: LlmUsage = { inputTokens: null, cachedTokens: null, outputTokens: null };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      let payload: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: Record<string, unknown>;
      };
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const { textDelta } = applyStreamChunk(acc, payload);
      if (textDelta) await onDelta(textDelta);
      if (payload?.usage) {
        usage.inputTokens = (payload.usage.prompt_tokens as number) ?? null;
        usage.outputTokens = (payload.usage.completion_tokens as number) ?? null;
        const details = payload.usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
        usage.cachedTokens = details?.cached_tokens ?? null;
      }
    }
  }

  const finalized = finalizeStreamAccumulator(acc);
  return { text: finalized.text, toolCalls: finalized.toolCalls, finishReason: finalized.finishReason, usage };
}
