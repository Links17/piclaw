import { describe, expect, test } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@piclaw/agent-kernel";

import { normalizeAgentMessages, normalizeLlmContext } from "../../src/agent-pool/llm-context-normalizer.js";

const FUZZ_SEED = 5885;
const FUZZ_CASES = 256;

const OPENAI_COMPLETIONS_MODEL: Model<"openai-completions"> = {
  id: "gpt-fuzz",
  name: "GPT Fuzz",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const OPENAI_COMPLETIONS_COMPAT = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: true,
} as const;

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function maybe<T>(rand: () => number, value: T): T | undefined {
  return rand() < 0.35 ? undefined : value;
}

function randomScalar(rand: () => number): unknown {
  return pick(rand, [
    undefined,
    null,
    "",
    "plain text",
    "emoji 👩🏽‍💻🚀 zero-width\u200d rtl \u202eabc\u202c",
    0,
    42,
    -1,
    true,
    false,
    BigInt(7),
    Symbol.for("piclaw-fuzz"),
  ]);
}

function randomContentBlock(rand: () => number): unknown {
  const variant = Math.floor(rand() * 9);
  if (variant === 0) return { type: "text", text: "hello" };
  if (variant === 1) return { type: "text", text: randomScalar(rand) };
  if (variant === 2) return { type: "image", mimeType: "image/png", data: "AAAA" };
  if (variant === 3) return { type: "image", mimeType: randomScalar(rand), data: randomScalar(rand) };
  if (variant === 4) return { type: "thinking", thinking: randomScalar(rand), thinkingSignature: maybe(rand, "sig") };
  if (variant === 5) return { type: "toolCall", id: randomScalar(rand), name: randomScalar(rand), arguments: randomScalar(rand) };
  if (variant === 6) return { type: "unknown", value: randomScalar(rand) };
  if (variant === 7) return randomScalar(rand);
  return [randomScalar(rand), { nested: true }];
}

function randomContent(rand: () => number): unknown {
  const variant = Math.floor(rand() * 8);
  if (variant === 0) return "valid string content";
  if (variant === 1) return undefined;
  if (variant === 2) return null;
  if (variant === 3) return randomScalar(rand);
  if (variant === 4) return { text: "object content" };
  const count = Math.floor(rand() * 5);
  return Array.from({ length: count }, () => randomContentBlock(rand));
}

function randomAgentMessage(rand: () => number, index: number): unknown {
  const role = pick(rand, ["user", "custom", "assistant", "toolResult", "branchSummary", "compactionSummary", "unknown"]);
  const timestamp = rand() < 0.7 ? Date.now() + index : randomScalar(rand);

  if (role === "user") {
    return { role, content: randomContent(rand), timestamp };
  }
  if (role === "custom") {
    return {
      role,
      customType: rand() < 0.7 ? "fuzz" : randomScalar(rand),
      content: randomContent(rand),
      display: rand() < 0.5,
      details: rand() < 0.5 ? { case: index } : randomScalar(rand),
      timestamp,
    };
  }
  if (role === "assistant") {
    return {
      role,
      content: randomContent(rand),
      api: "openai-completions",
      provider: "openai",
      model: "gpt-fuzz",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: rand() < 0.2 ? "error" : "stop",
      timestamp,
    };
  }
  if (role === "toolResult") {
    return {
      role,
      toolCallId: rand() < 0.7 ? `call-${index}` : randomScalar(rand),
      toolName: rand() < 0.7 ? "tool" : randomScalar(rand),
      content: randomContent(rand),
      isError: rand() < 0.5 ? false : randomScalar(rand),
      timestamp,
    };
  }
  if (role === "branchSummary") {
    return { role, summary: randomScalar(rand), fromId: randomScalar(rand), timestamp };
  }
  if (role === "compactionSummary") {
    return { role, summary: randomScalar(rand), tokensBefore: randomScalar(rand), timestamp };
  }
  return rand() < 0.5 ? { role, content: randomContent(rand), timestamp } : randomScalar(rand);
}

function assertOpenAIConversionDoesNotThrow(messages: unknown[]): void {
  const normalizedContext = normalizeLlmContext({ messages: messages as any });
  expect(() => convertMessages(OPENAI_COMPLETIONS_MODEL, normalizedContext, OPENAI_COMPLETIONS_COMPAT as any)).not.toThrow();
}

describe("LLM context fuzz coverage", () => {
  test("normalizer prevents the issue-5885 undefined user content crash", () => {
    assertOpenAIConversionDoesNotThrow([
      { role: "user", content: undefined, timestamp: Date.now() },
    ]);
  });

  test("malformed persisted/custom messages survive conversion to OpenAI chat params", () => {
    const rand = mulberry32(FUZZ_SEED);

    for (let caseId = 0; caseId < FUZZ_CASES; caseId += 1) {
      const count = 1 + Math.floor(rand() * 8);
      const agentMessages = Array.from({ length: count }, (_, index) => randomAgentMessage(rand, caseId * 10 + index));
      const normalizedAgentMessages = normalizeAgentMessages(agentMessages as any);
      const llmMessages = convertToLlm(normalizedAgentMessages);

      try {
        assertOpenAIConversionDoesNotThrow(llmMessages as any[]);
      } catch (error) {
        throw new Error(
          `LLM context fuzz case ${caseId} failed for seed ${FUZZ_SEED}: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ agentMessages, normalizedAgentMessages, llmMessages }, (_key, value) => typeof value === "bigint" ? `${value}n` : typeof value === "symbol" ? String(value) : value, 2)}`,
          { cause: error },
        );
      }
    }
  });
});
