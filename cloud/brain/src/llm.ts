/**
 * LLM adapter — mock streamer for infra tests; optional OpenAI-compatible provider.
 */
import { config } from "./config.ts";
import type { MessageRow } from "@piclaw-cloud/store";

export interface LlmUsage {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export async function streamCompletion(
  history: MessageRow[],
  onDelta: (text: string) => Promise<void>,
  options: { prefix?: string } = {},
): Promise<LlmResult> {
  if (config.openaiBaseUrl && config.openaiApiKey) {
    return streamOpenAi(history, onDelta);
  }
  return streamMock(history, onDelta, options.prefix ?? "");
}

async function streamMock(
  history: MessageRow[],
  onDelta: (text: string) => Promise<void>,
  prefix: string,
): Promise<LlmResult> {
  const last = [...history].reverse().find((m) => m.role === "user");
  const prompt = last?.content ?? "";
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
  if (prefix) {
    parts.push(prefix);
    await onDelta(prefix);
  }
  for (let i = 0; i < tokens; i += 1) {
    const piece = i === 0 && !prefix ? `mock-reply(to: ${prompt.slice(0, 24)})` : ` t${i}`;
    parts.push(piece);
    await onDelta(piece);
    await Bun.sleep(delayMs);
  }
  return {
    text: parts.join(""),
    usage: { inputTokens: null, cachedTokens: null, outputTokens: tokens },
  };
}

async function streamOpenAi(
  history: MessageRow[],
  onDelta: (text: string) => Promise<void>,
): Promise<LlmResult> {
  const messages = [
    {
      role: "system",
      content: "You are a terse assistant for a streaming infrastructure test. Answer briefly.",
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const response = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages,
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
  let text = "";
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
      let payload: { choices?: Array<{ delta?: { content?: string } }>; usage?: Record<string, unknown> };
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = payload?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        await onDelta(delta);
      }
      if (payload?.usage) {
        usage.inputTokens = (payload.usage.prompt_tokens as number) ?? null;
        usage.outputTokens = (payload.usage.completion_tokens as number) ?? null;
        const details = payload.usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
        usage.cachedTokens = details?.cached_tokens ?? null;
      }
    }
  }
  return { text, usage };
}
