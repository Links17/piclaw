import { describe, expect, test } from "bun:test";
import {
  assistantMessageToRow,
  rowsToAgentMessages,
  trimLeadingOrphanToolResults,
  toolResultMessageToRow,
} from "./message-map.ts";

describe("message-map", () => {
  test("rowsToAgentMessages maps user and assistant text", () => {
    const messages = rowsToAgentMessages(
      [
        {
          id: 1,
          session_id: "web:abc",
          role: "user",
          content: "hello",
          content_blocks: null,
          recovery_marker: false,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          session_id: "web:abc",
          role: "assistant",
          content: "hi there",
          content_blocks: null,
          recovery_marker: false,
          created_at: "2026-01-01T00:00:01.000Z",
        },
      ],
      "gpt-test",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
  });

  test("trimLeadingOrphanToolResults drops orphan tool rows", () => {
    const trimmed = trimLeadingOrphanToolResults([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      },
      { role: "user", content: "hello", timestamp: 2 },
    ]);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.role).toBe("user");
  });

  test("assistantMessageToRow preserves tool calls", () => {
    const row = assistantMessageToRow({
      role: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pwd" } },
      ],
      api: "openai-completions",
      provider: "piclaw-cloud",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    });
    expect(row.content).toBe("running");
    expect(row.contentBlocks).toEqual({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
        },
      ],
    });
  });

  test("toolResultMessageToRow maps tool result metadata", () => {
    const row = toolResultMessageToRow({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    });
    expect(row.content).toBe("done");
    expect(row.contentBlocks).toEqual({
      tool_call_id: "call_1",
      tool_name: "bash",
    });
  });
});
