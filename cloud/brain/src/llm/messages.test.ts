import { describe, expect, test } from "bun:test";
import { BASE_SYSTEM_PROMPT, historyToOpenAi } from "./messages.ts";
import type { MessageRow } from "@piclaw-cloud/store";

describe("historyToOpenAi", () => {
  test("tells the agent to discover and activate optional tools", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("list_tools");
    expect(BASE_SYSTEM_PROMPT).toContain("activate_tools");
    expect(BASE_SYSTEM_PROMPT).toContain("coding_agent");
  });

  test("includes assistant tool_calls and tool results", () => {
    const rows: MessageRow[] = [
      {
        id: 1,
        session_id: "s1",
        role: "user",
        content: "write a demo",
        content_blocks: null,
        recovery_marker: false,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        session_id: "s1",
        role: "assistant",
        content: "",
        content_blocks: {
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "write", arguments: "{\"path\":\"/workspace/a.ino\"}" },
          }],
        },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        id: 3,
        session_id: "s1",
        role: "tool",
        content: "Wrote 10 bytes",
        content_blocks: { tool_call_id: "call_1", tool_name: "write" },
        recovery_marker: false,
        created_at: "2026-01-01T00:00:02Z",
      },
    ];

    const messages = historyToOpenAi(rows);
    expect(messages.some((m) => m.role === "assistant" && "tool_calls" in m)).toBe(true);
    expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
  });
});
