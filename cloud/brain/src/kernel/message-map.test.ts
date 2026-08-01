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
    }, { userMessageId: 42, operationId: "turn:web:abc:42", attempt: 1 });
    expect(row.content).toBe("running");
    expect(row.contentBlocks).toEqual({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
        },
      ],
      user_message_id: 42,
      turn_operation_id: "turn:web:abc:42",
      usage_receipt: {
        version: 1,
        user_message_id: 42,
        operation_id: "turn:web:abc:42",
        attempt: 1,
        provider: "piclaw-cloud",
        model: "gpt-test",
        input_tokens: 1,
        output_tokens: 1,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        status: "success",
      },
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
    }, { userMessageId: 42, operationId: "turn:web:abc:42" });
    expect(row.content).toBe("done");
    expect(row.contentBlocks).toEqual({
      tool_call_id: "call_1",
      tool_name: "bash",
      user_message_id: 42,
      turn_operation_id: "turn:web:abc:42",
    });
  });

  test("compacts only explicitly selected tool results", () => {
    const rows = [
      {
        id: 1,
        session_id: "web:abc",
        role: "assistant" as const,
        content: "",
        content_blocks: {
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: "{}" },
          }],
        },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        session_id: "web:abc",
        role: "tool" as const,
        content: "x".repeat(500),
        content_blocks: { tool_call_id: "call_1", tool_name: "bash" },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:01.000Z",
      },
      {
        id: 3,
        session_id: "web:abc",
        role: "assistant" as const,
        content: "",
        content_blocks: {
          tool_calls: [{
            id: "call_2",
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:02.000Z",
      },
      {
        id: 4,
        session_id: "web:abc",
        role: "tool" as const,
        content: "y".repeat(500),
        content_blocks: { tool_call_id: "call_2", tool_name: "read" },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:03.000Z",
      },
    ];

    const messages = rowsToAgentMessages(rows, "gpt-test", {
      toolResultMaxChars: 80,
      toolResultCompactionTools: ["bash"],
    });

    expect(messages[1]?.role).toBe("toolResult");
    expect(messages[1]?.role === "toolResult" && messages[1].content[0]?.type === "text"
      ? messages[1].content[0].text.length
      : 0)
      .toBeLessThanOrEqual(80);
    expect(messages[3]?.role).toBe("toolResult");
    expect(messages[3]?.role === "toolResult" && messages[3].content[0]?.type === "text"
      ? messages[3].content[0].text
      : "")
      .toBe("y".repeat(500));
  });
});
