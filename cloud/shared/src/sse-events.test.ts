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

  test("maps turn_aborted to classic done status", () => {
    const mapped = mapInternalToSse(scope, {
      type: "turn_aborted",
      messageId: 42,
      replica: "A",
    });
    expect(mapped?.data.type).toBe("done");
    expect(mapped?.data.title).toBe("Stopped");
  });

  test("maps user-aborted turn_failed to done", () => {
    const mapped = mapInternalToSse(scope, {
      type: "turn_failed",
      messageId: 42,
      error: "Turn aborted by user",
      replica: "A",
    });
    expect(mapped?.data.type).toBe("done");
  });

  test("maps workspace_update to classic workspace_update", () => {
    const mapped = mapInternalToSse(scope, {
      type: "workspace_update",
      path: "demo.ino",
      replica: "A",
    });
    expect(mapped).toEqual({
      event: "workspace_update",
      data: {
        updates: [{ path: "demo.ino", truncated: true }],
        chat_jid: "web:test",
        turn_id: "42",
      },
    });
  });
});

describe("subagent sse mapping", () => {
  test("maps subagent_started to subagent_updated", () => {
    const mapped = mapInternalToSse(scope, {
      type: "subagent_started",
      runId: "run-1",
      agentType: "coding",
      task: "write demo",
      replica: "A",
    });
    expect(mapped?.event).toBe("subagent_updated");
    expect(mapped?.data.status).toBe("running");
    expect(mapped?.data.run_id).toBe("run-1");
    expect(mapped?.data.chat_jid).toBe("web:test");
  });

  test("maps question_asked to agent_question", () => {
    const mapped = mapInternalToSse(scope, {
      type: "question_asked",
      questionId: "q-1",
      question: "Pick one",
      options: [{ label: "A" }],
      replica: "A",
    });
    expect(mapped?.event).toBe("agent_question");
    expect(mapped?.data.question_id).toBe("q-1");
  });

  test("maps question_cleared to agent_question_cleared", () => {
    const mapped = mapInternalToSse(scope, {
      type: "question_cleared",
      replica: "A",
    });
    expect(mapped?.event).toBe("agent_question_cleared");
  });
});
