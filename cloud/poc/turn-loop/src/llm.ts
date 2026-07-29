/**
 * LLM provider adapter. Default is a deterministic mock streamer so the
 * mutex / recovery / follow-up mechanics can be tested without a key.
 * Set POC_OPENAI_BASE_URL + POC_OPENAI_API_KEY to run against a real
 * OpenAI-compatible endpoint and collect cached-token usage.
 */
import { config } from "./config.ts";
import type { MessageRow } from "./store.ts";

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
): Promise<LlmResult> {
  if (config.openaiBaseUrl && config.openaiApiKey) {
    return streamOpenAi(history, onDelta);
  }
  return streamMock(history, onDelta);
}

// ── mock provider ─────────────────────────────────────────────────────

/**
 * Mock streaming: replies with a canned summary token by token.
 * The latest user message controls pacing for test scenarios:
 *   - starts with "slow"  → 40 tokens at 500ms (~20s turn, kill window)
 *   - starts with "medium"→ 20 tokens at 150ms (~3s turn)
 *   - otherwise           → 8 tokens at 30ms (fast)
 */
async function streamMock(
  history: MessageRow[],
  onDelta: (text: string) => Promise<void>,
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
  for (let i = 0; i < tokens; i += 1) {
    const piece = i === 0 ? `mock-reply(to: ${prompt.slice(0, 24)})` : ` t${i}`;
    parts.push(piece);
    await onDelta(piece);
    await Bun.sleep(delayMs);
  }
  return {
    text: parts.join(""),
    usage: { inputTokens: null, cachedTokens: null, outputTokens: tokens },
  };
}

// ── OpenAI-compatible provider ────────────────────────────────────────

async function streamOpenAi(
  history: MessageRow[],
  onDelta: (text: string) => Promise<void>,
): Promise<LlmResult> {
  const messages = [
    // Stable prefix on purpose: byte-identical system prompt across turns is
    // the KV-cache strategy under test (design doc §11).
    { role: "system", content: "You are a terse assistant for a streaming infrastructure test. Answer briefly." },
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
      let payload: any;
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
        usage.inputTokens = payload.usage.prompt_tokens ?? null;
        usage.outputTokens = payload.usage.completion_tokens ?? null;
        usage.cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens ?? null;
      }
    }
  }
  return { text, usage };
}
