import { expect, test } from "bun:test";
import type { AssistantMessage } from "@piclaw/agent-kernel";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";

import "../helpers.js";
import { createCompactionStreamFn } from "../../src/agent-pool/session.js";

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createFauxFixture() {
  const namespace = `compaction-runtime-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const providerId = `faux-${namespace}`;
  return registerFauxProvider({
    api: providerId,
    provider: providerId,
    models: [{ id: providerId, name: `Faux ${namespace}` }],
  });
}

test("createCompactionStreamFn delegates request preparation to ModelRuntime exactly once", async () => {
  const runtimeCalls: Array<{ model: unknown; context: unknown; options: any }> = [];
  const providerCalls: Array<{ model: unknown; context: unknown; options: any }> = [];
  const faux = createFauxFixture();
  faux.setResponses([(_context, options, _state, model) => {
    providerCalls.push({ model, context: _context, options });
    return assistantMessage("ok");
  }]);

  try {
    const streamFn = createCompactionStreamFn(
      {
        streamSimple(model: any, context: any, options: any) {
          runtimeCalls.push({ model, context, options });
          return streamSimple(model, context, {
            ...options,
            apiKey: "runtime-key",
            headers: { "X-Runtime": "1" },
            env: { RUNTIME_ENV: "yes" },
          });
        },
      } as any,
      { getProviderRetrySettings: () => ({ timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 345 }) } as any,
    );

    const stream = await streamFn(
      faux.getModel()!,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hello" }] },
      { maxTokens: 32 } as any,
    );
    await stream.result();

    expect(runtimeCalls).toHaveLength(1);
    expect(runtimeCalls[0].options).toMatchObject({
      maxTokens: 32,
      timeoutMs: 1234,
      maxRetries: 2,
      maxRetryDelayMs: 345,
    });
    expect(runtimeCalls[0].options.apiKey).toBeUndefined();
    expect(runtimeCalls[0].options.headers).toBeUndefined();
    expect(runtimeCalls[0].options.env).toBeUndefined();
    expect(providerCalls[0].options).toMatchObject({
      apiKey: "runtime-key",
      headers: { "X-Runtime": "1" },
      env: { RUNTIME_ENV: "yes" },
    });
  } finally {
    faux.unregister();
  }
});
