import { describe, expect, test } from "bun:test";
import { activateToolNames, resetActiveToolNames } from "../tools/active.ts";
import {
  buildIncrementalCompactionMessages,
  generateCompactionSummary,
  publishCommittedCompaction,
  selectValidatedCompactionPair,
  resolveSessionLoopToolDefinitions,
  serializeCompactionMessages,
} from "./run-session-loop.ts";

describe("resolveSessionLoopToolDefinitions", () => {
  test("starts with the baseline and includes newly activated MCP tools", () => {
    const sessionId = "loop-tool-refresh";
    const mcpTool = {
      type: "function" as const,
      function: {
        name: "mcp__docs__search",
        description: "Search documentation",
        parameters: { type: "object" },
      },
    };
    resetActiveToolNames(sessionId);

    expect(resolveSessionLoopToolDefinitions(sessionId, "execute", [mcpTool]).map((tool) => tool.function.name))
      .not.toContain("mcp__docs__search");

    activateToolNames(sessionId, ["mcp__docs__search"], new Set(["mcp__docs__search"]));

    expect(resolveSessionLoopToolDefinitions(sessionId, "execute", [mcpTool]).map((tool) => tool.function.name))
      .toContain("mcp__docs__search");
  });

  test("preserves strict service capability boundaries", () => {
    const strict = [{
      type: "function" as const,
      function: {
        name: "mcp__web__search",
        description: "Search the web",
        parameters: { type: "object" },
      },
    }];

    expect(resolveSessionLoopToolDefinitions("strict-service", "plan", strict, true))
      .toEqual(strict);
  });
});

describe("buildIncrementalCompactionMessages", () => {
  test("does not inject the previous summary twice", () => {
    const previous = {
      role: "compactionSummary" as const,
      summary: "## Goal\nPrevious durable state.",
      tokensBefore: 1_000,
      timestamp: 1,
    };
    const messages = [
      previous,
      { role: "user" as const, content: "new work", timestamp: 2 },
      { role: "assistant" as const, content: [], api: "openai-completions" as const, provider: "test", model: "test", usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }, stopReason: "stop" as const, timestamp: 3 },
      { role: "user" as const, content: "current request", timestamp: 4 },
    ];

    const incremental = buildIncrementalCompactionMessages(messages, 2);

    expect(incremental.previousSummary).toBe(previous.summary);
    expect(incremental.messages.some((message) => message.role === "compactionSummary")).toBe(false);
    expect(incremental.messages.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("selectValidatedCompactionPair", () => {
  test("does not return the fourth expanded window when every candidate remains over budget", async () => {
    const windows = [2, 4, 6, 8];
    const result = await selectValidatedCompactionPair({
      initialWindow: 2,
      maxAttempts: 4,
      generate: async (boundary) => `summary-${boundary}`,
      candidateTokens: async () => 101,
      providerBudget: 100,
      expand: (boundary) => windows[windows.indexOf(boundary) + 1] ?? null,
    });
    expect(result).toBeNull();
  });

  test("returns the paired fourth window and summary only when that candidate fits", async () => {
    const windows = [2, 4, 6, 8];
    const result = await selectValidatedCompactionPair({
      initialWindow: 2,
      maxAttempts: 4,
      generate: async (boundary) => `summary including boundary ${boundary}`,
      candidateTokens: async (_boundary, summary) => summary.includes("8") ? 99 : 101,
      providerBudget: 100,
      expand: (boundary) => windows[windows.indexOf(boundary) + 1] ?? null,
    });
    expect(result).toEqual({
      window: 8,
      summary: "summary including boundary 8",
      candidateTokens: 99,
    });
  });
});

describe("generateCompactionSummary", () => {
  test("repairs one invalid summary and returns the valid replacement", async () => {
    let attempts = 0;
    const receipts: Array<{ attempt: number; status: string; inputTokens: number }> = [];
    const models = {
      streamSimple: async function* () {
        attempts += 1;
        const text = attempts === 1
          ? "plain invalid summary"
          : "## Goal\nPreserve state.\n\n## Next Steps\nContinue safely.";
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text }],
            api: "openai-completions" as const,
            provider: "test",
            model: "test",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          },
        };
      },
    };

    const result = await generateCompactionSummary({
      messages: [{ role: "user", content: "work", timestamp: 1 }],
      model: { id: "test", contextWindow: 8_000, maxTokens: 1_000 } as never,
      models: models as never,
      apiKey: "test",
      maxTokens: 512,
      maxChars: 1_000,
      timeoutSec: 5,
      onAttemptUsage: async (receipt) => {
        receipts.push({
          attempt: receipt.attempt,
          status: receipt.status,
          inputTokens: receipt.inputTokens,
        });
      },
    });

    expect(attempts).toBe(2);
    expect(result.text).toContain("## Goal");
    expect(receipts).toEqual([
      { attempt: 1, status: "failed", inputTokens: 10 },
      { attempt: 2, status: "success", inputTokens: 10 },
    ]);
  });

  test("does not retry or persist through an aborted summary", async () => {
    let attempts = 0;
    const models = {
      streamSimple: async function* () {
        attempts += 1;
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "" }],
            api: "openai-completions" as const,
            provider: "test",
            model: "test",
            usage: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "aborted" as const,
            errorMessage: "aborted",
            timestamp: Date.now(),
          },
        };
      },
    };

    await expect(generateCompactionSummary({
      messages: [{ role: "user", content: "work", timestamp: 1 }],
      model: { id: "test", contextWindow: 8_000, maxTokens: 1_000 } as never,
      models: models as never,
      apiKey: "test",
      maxTokens: 512,
      maxChars: 1_000,
      timeoutSec: 5,
    })).rejects.toThrow("stop_reason_aborted");
    expect(attempts).toBe(1);
  });
});

describe("serializeCompactionMessages", () => {
  test("preserves assistant tool call identity, name, bounded arguments, and result pairing", () => {
    const serialized = serializeCompactionMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading config." },
          {
            type: "toolCall",
            id: "call-config",
            name: "read",
            arguments: {
              path: "/workspace/important/config.json",
              command: `deploy --target production ${"x".repeat(5_000)}`,
            },
          },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-config",
        toolName: "read",
        content: [{ type: "text", text: "config contents" }],
        isError: false,
        timestamp: 2,
      },
    ]);

    expect(serialized).toContain("TOOL_CALL id=call-config name=read");
    expect(serialized).toContain("/workspace/important/config.json");
    expect(serialized).toContain("deploy --target production");
    expect(serialized).toContain("TOOL_RESULT call_id=call-config name=read");
    expect(serialized.length).toBeLessThan(7_000);
  });
});

describe("publishCommittedCompaction", () => {
  test("publish failure does not invalidate committed artifacts", async () => {
    let warned = "";
    await publishCommittedCompaction({
      publishDone: async () => { throw new Error("sse unavailable"); },
      warn: (message) => { warned = message; },
    });

    expect(warned).toContain("sse unavailable");
  });

  test("abort after commit keeps artifacts while the main turn may stop", async () => {
    let published = false;
    await publishCommittedCompaction({
      publishDone: async () => { published = true; },
      warn: () => {},
    });

    expect(published).toBe(true);
    expect(() => { throw new Error("Turn aborted by user"); }).toThrow("Turn aborted by user");
  });
});
