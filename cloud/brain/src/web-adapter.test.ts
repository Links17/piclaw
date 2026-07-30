import { describe, expect, test } from "bun:test";
import { agentResponseSsePayload, messageToPost, userPostPayload } from "./web-adapter.ts";

describe("web-adapter post shapes", () => {
  test("messageToPost sets data.type for user and assistant", () => {
    const user = messageToPost(
      { id: 1, session_id: "s", role: "user", content: "hi", created_at: "t", recovery_marker: false, content_blocks: null },
      "web:s",
    );
    expect(user.data.type).toBe("user_message");

    const bot = messageToPost(
      { id: 2, session_id: "s", role: "assistant", content: "yo", created_at: "t", recovery_marker: false, content_blocks: null },
      "web:s",
    );
    expect(bot.data.type).toBe("agent_response");
  });

  test("userPostPayload includes chat_jid and thread_id", () => {
    const post = userPostPayload("web:s", 5, "hello");
    expect(post.chat_jid).toBe("web:s");
    expect(post.data.type).toBe("user_message");
    expect(post.data.thread_id).toBe(5);
  });

  test("agentResponseSsePayload includes agent_response type", () => {
    const post = agentResponseSsePayload("web:s", 6, "reply");
    expect(post.chat_jid).toBe("web:s");
    expect(post.data.type).toBe("agent_response");
    expect(post.id).toBe(6);
  });

  test("isTimelineVisibleMessage hides tool rows and assistant tool_calls", async () => {
    const { isTimelineVisibleMessage } = await import("./web-adapter.ts");
    expect(isTimelineVisibleMessage({ role: "user" } as any)).toBe(true);
    expect(isTimelineVisibleMessage({ role: "tool" } as any)).toBe(false);
    expect(
      isTimelineVisibleMessage({
        role: "assistant",
        content_blocks: { tool_calls: [{ id: "c1" }] },
      } as any),
    ).toBe(false);
    expect(isTimelineVisibleMessage({ role: "assistant", content_blocks: null } as any)).toBe(true);
  });
});
