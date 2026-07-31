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
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tools/schemas.ts";
import { TurnAbortedError, isTurnAborted, throwIfAborted } from "./turn-abort.ts";

export interface StreamCompletionOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

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

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      "LLM not configured: set openai.baseUrl and openai.apiKey in cloud/brain.config.json",
    );
    this.name = "LlmNotConfiguredError";
  }
}

/** When true, mock-tools:/mock-coding: prefixes use deterministic test responses. */
export function isLlmMockEnabled(): boolean {
  return process.env.CLOUD_LLM_MOCK === "1";
}

function isOpenAiConfigured(): boolean {
  return Boolean(config.openaiBaseUrl && config.openaiApiKey);
}

export async function streamCompletionRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  tools: ToolDefinition[] = TOOL_DEFINITIONS,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser && "content" in lastUser ? String(lastUser.content ?? "") : "";
  const isMockPrefix = prompt.startsWith("mock-tools:") || prompt.startsWith("mock-coding:");
  if (isMockPrefix && isLlmMockEnabled()) {
    return streamMockRound(messages, onDelta, prompt, options);
  }
  if (isLlmMockEnabled() && isScenarioMockPrompt(prompt)) {
    return streamScenarioMockRound(messages, onDelta, prompt, options);
  }
  if (isOpenAiConfigured()) {
    return streamOpenAiRound(messages, onDelta, tools, options);
  }
  throw new LlmNotConfiguredError();
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
  prompt: string,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  throwIfAborted(options.sessionId ?? "", options.signal);
  if (prompt.startsWith("mock-tools:")) {
    return mockToolsRound(messages, onDelta, prompt, options);
  }
  if (prompt.startsWith("mock-coding:")) {
    return mockCodingRound(messages, onDelta, prompt, options);
  }
  throw new Error(`mock prefix required when CLOUD_LLM_MOCK=1 (got: ${prompt.slice(0, 40)})`);
}

function isScenarioMockPrompt(prompt: string): boolean {
  return (
    prompt.includes("hello quick") ||
    prompt.includes("medium first") ||
    prompt.includes("second while busy") ||
    prompt.includes("slow doomed turn") ||
    prompt.includes("count me")
  );
}

async function streamScenarioMockRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  prompt: string,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  throwIfAborted(options.sessionId ?? "", options.signal);
  const text =
    prompt.includes("slow doomed turn") || prompt.includes("medium first")
      ? "Mock busy turn streaming output for abort testing."
      : prompt.includes("count me")
        ? "Counted."
        : "Mock quick reply.";
  const slow = prompt.includes("slow doomed turn");
  if (slow) {
    for (const char of text) {
      throwIfAborted(options.sessionId ?? "", options.signal);
      await onDelta(char);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } else {
    await streamMockTextWithAbortCheck(text, onDelta, options);
  }
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: text.length },
  };
}

async function streamMockTextWithAbortCheck(
  text: string,
  onDelta: (text: string) => Promise<void>,
  options: StreamCompletionOptions = {},
): Promise<void> {
  for (const char of text) {
    throwIfAborted(options.sessionId ?? "", options.signal);
    await onDelta(char);
    if (text.length > 32) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function mockToolsRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  prompt: string,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  const hasToolResults = messages.some((m) => m.role === "tool");
  const hasAssistantTools = messages.some(
    (m) => m.role === "assistant" && "tool_calls" in m && (m.tool_calls?.length ?? 0) > 0,
  );

  if (!hasAssistantTools) {
    if (prompt.includes("medium busy turn")) {
      const text = "Mock busy turn streaming output for abort testing.";
      await streamMockTextWithAbortCheck(text, onDelta, options);
      return {
        text,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: text.length },
      };
    }
    if (prompt.includes("question")) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call_mock_question",
            name: "question",
            arguments: JSON.stringify({
              question: "Which target platform should we use?",
              options: [{ label: "Wio Terminal" }, { label: "ESP32" }],
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      };
    }
    if (prompt.includes("todo")) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call_mock_todo",
            name: "todo",
            arguments: JSON.stringify({ action: "add", text: "Implement mock feature" }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      };
    }
    if (prompt.includes("coding_agent") || prompt.includes("coding-agent") || prompt.includes("Agent")) {
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
    const hadQuestion = messages.some((m) => m.role === "tool" && m.content.includes("User selected"));
    const text = hadQuestion
      ? "Thanks for clarifying — proceeding with Wio Terminal."
      : prompt.includes("edit")
        ? "Updated the demo to hello agent."
        : "Created the hello world demo.";
    await streamMockTextWithAbortCheck(text, onDelta, options);
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
  options: StreamCompletionOptions = {},
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
    await streamMockTextWithAbortCheck(text, onDelta, options);
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
  tools: ToolDefinition[] = TOOL_DEFINITIONS,
  options: StreamCompletionOptions = {},
): Promise<CompletionRound> {
  throwIfAborted(options.sessionId ?? "", options.signal);
  let response: Response;
  try {
    response = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      signal: options.signal,
      body: JSON.stringify({
        model: config.openaiModel,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    if (options.signal?.aborted || isTurnAborted(options.sessionId ?? "")) {
      throw new TurnAbortedError();
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    throw new Error(`LLM HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const acc = createStreamAccumulator();
  const usage: LlmUsage = { inputTokens: null, cachedTokens: null, outputTokens: null };

  while (true) {
    throwIfAborted(options.sessionId ?? "", options.signal);
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
      if (textDelta) {
        throwIfAborted(options.sessionId ?? "", options.signal);
        await onDelta(textDelta);
      }
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
