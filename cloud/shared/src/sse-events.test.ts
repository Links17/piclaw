import { describe, expect, test } from "bun:test";
import { mapInternalToSse, mapInternalToWeb } from "@piclaw-cloud/shared/sse-events";

const scope = { chatJid: "web:test", turnId: "42" };

describe("@piclaw-cloud/shared sse-events", () => {
  test("maps delta to agent_draft_delta with chat_jid", () => {
    const mapped = mapInternalToSse(scope, { type: "delta", text: "hi", replica: "A" });
    expect(mapped).toEqual({
      event: "agent_draft_delta",
      data: { delta: "hi", chat_jid: "web:test", turn_id: "42" },
    });
  });

  test("maps followup_queued with chat_jid", () => {
    const mapped = mapInternalToSse(scope, { type: "followup_queued", content: "next" });
    expect(mapped).toEqual({
      event: "agent_followup_queued",
      data: { content: "next", chat_jid: "web:test", turn_id: "42" },
    });
  });

  test("maps tool_start to classic agent_status tool", () => {
    const mapped = mapInternalToSse(scope, { type: "tool_start", name: "write", toolCallId: "c1", replica: "A" });
    expect(mapped).toEqual({
      event: "agent_status",
      data: {
        type: "tool",
        title: "write",
        detail: "write",
        chat_jid: "web:test",
        turn_id: "42",
      },
    });
  });

  test("maps turn_done to classic done status", () => {
    const mapped = mapInternalToSse(scope, {
      type: "turn_done",
      messageId: 42,
      replica: "A",
      dbRoundtrips: 1,
      durationMs: 10,
    });
    expect(mapped?.data.type).toBe("done");
    expect(mapped?.data.chat_jid).toBe("web:test");
  });

  test("legacy mapInternalToWeb still maps delta", () => {
    const mapped = mapInternalToWeb("s1", { type: "delta", text: "hi", replica: "A" }, scope);
    expect(mapped).toEqual({ type: "agent_draft_delta", delta: "hi" });
  });
});

describe("subagent sse mapping", () => {
  test("maps subagent_started to tool status", () => {
    const mapped = mapInternalToSse(scope, {
      type: "subagent_started",
      runId: "run-1",
      agentType: "coding",
      task: "write demo",
      replica: "A",
    });
    expect(mapped?.event).toBe("agent_status");
    expect(mapped?.data.type).toBe("tool");
    expect(mapped?.data.detail).toBe("coding:run-1");
    expect(mapped?.data.chat_jid).toBe("web:test");
  });
});
