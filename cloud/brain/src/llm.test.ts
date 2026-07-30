import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenAiMessage } from "./llm/messages.ts";

mock.module("./config.ts", () => ({
  config: {
    openaiBaseUrl: "",
    openaiApiKey: "",
    openaiModel: "test-model",
  },
}));

const { streamCompletionRound, LlmNotConfiguredError, isLlmMockEnabled } = await import("./llm.ts");

const userMessage = (content: string): OpenAiMessage[] => [{ role: "user", content }];

describe("llm mock gating", () => {
  const originalMockEnv = process.env.CLOUD_LLM_MOCK;

  afterEach(() => {
    if (originalMockEnv === undefined) delete process.env.CLOUD_LLM_MOCK;
    else process.env.CLOUD_LLM_MOCK = originalMockEnv;
  });

  test("isLlmMockEnabled requires CLOUD_LLM_MOCK=1", () => {
    delete process.env.CLOUD_LLM_MOCK;
    expect(isLlmMockEnabled()).toBe(false);
    process.env.CLOUD_LLM_MOCK = "1";
    expect(isLlmMockEnabled()).toBe(true);
  });

  test("LlmNotConfiguredError has helpful message", () => {
    const err = new LlmNotConfiguredError();
    expect(err.name).toBe("LlmNotConfiguredError");
    expect(err.message).toContain("brain.config.json");
  });

  test("normal message without openai throws instead of mock-reply", async () => {
    delete process.env.CLOUD_LLM_MOCK;
    const deltas: string[] = [];
    await expect(
      streamCompletionRound(userMessage("我想做一个油车占位系统"), async (delta) => {
        deltas.push(delta);
      }),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(deltas.join("")).not.toContain("mock-reply");
  });

  test("mock-tools without CLOUD_LLM_MOCK throws LlmNotConfiguredError", async () => {
    delete process.env.CLOUD_LLM_MOCK;
    await expect(
      streamCompletionRound(userMessage("mock-tools: write"), async () => {}),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  test("mock-tools with CLOUD_LLM_MOCK=1 returns deterministic tool call", async () => {
    process.env.CLOUD_LLM_MOCK = "1";
    const deltas: string[] = [];
    const result = await streamCompletionRound(userMessage("mock-tools: write"), async (delta) => {
      deltas.push(delta);
    });
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe("write");
    expect(deltas.join("")).not.toContain("mock-reply");
  });
});
