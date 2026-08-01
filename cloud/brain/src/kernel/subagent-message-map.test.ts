import { describe, expect, test } from "bun:test";
import { subagentRowsToAgentMessages } from "./subagent-message-map.ts";

describe("subagent-message-map", () => {
  test("subagentRowsToAgentMessages maps user and tool rows", () => {
    const messages = subagentRowsToAgentMessages(
      [
        {
          id: 1,
          role: "user",
          content: "hello",
          content_blocks: null,
          created_at: new Date().toISOString(),
        },
        {
          id: 2,
          role: "tool",
          content: "ok",
          content_blocks: { tool_call_id: "call_1", tool_name: "read" },
          created_at: new Date().toISOString(),
        },
      ],
      "gpt-test",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("toolResult");
  });
});
