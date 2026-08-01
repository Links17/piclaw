import { beforeEach, describe, expect, mock, test } from "bun:test";
import { agentResponseSsePayload, messageToPost, sessionToBranchChat, userPostPayload } from "./web-adapter.ts";

const getSessionForUser = mock<() => Promise<{
  id: string;
  user_id: string;
  title: string;
  sandbox_id: string | null;
  workspace_volume_id: string | null;
} | null>>(async () => ({
  id: "web:owned",
  user_id: "user-a",
  title: "Owned chat",
  sandbox_id: "sandbox-123",
  workspace_volume_id: "volume-123",
}));
const isSessionLocked = mock(async () => false);
const deleteSession = mock(async () => ({
  id: "web:owned",
  user_id: "user-a",
  title: "Owned chat",
  sandbox_id: "sandbox-123",
  workspace_volume_id: "volume-123",
}));
const listSessions = mock(async (userId?: string) => [{
  id: `web:${userId}`,
  user_id: userId ?? "default-user",
  title: userId ?? "default-user",
  sandbox_id: null,
  workspace_volume_id: null,
}]);
mock.module("@piclaw-cloud/store", () => ({
  getSessionForUser,
  isSessionLocked,
  deleteSession,
  listSessions,
}));
mock.module("./agent-run-state.ts", () => ({
  getInflightTurn: () => undefined,
}));
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

describe("sessionToBranchChat", () => {
  test("does not expose archive state", () => {
    const branch = sessionToBranchChat({
      id: "web:test",
      title: "Test Chat",
    });
    expect(branch.chat_jid).toBe("web:test");
    expect(branch.agent_name).toBe("Test Chat");
    expect(branch).not.toHaveProperty("archived_at");
    expect(branch.is_root).toBe(true);
  });
});

describe("getActiveChatAgents ownership", () => {
  test("passes authenticated user to session listing", async () => {
    const { getActiveChatAgents } = await import("./web-adapter.ts");
    const result = await getActiveChatAgents("user-a");
    expect(listSessions).toHaveBeenCalledWith("user-a");
    expect(result.chats[0]?.chat_jid).toBe("web:user-a");
  });
});

describe("deleteChatBranch lifecycle", () => {
  beforeEach(() => {
    getSessionForUser.mockClear();
    isSessionLocked.mockClear();
    deleteSession.mockClear();
    getSessionForUser.mockResolvedValue({
      id: "web:owned",
      user_id: "user-a",
      title: "Owned chat",
      sandbox_id: "sandbox-123",
      workspace_volume_id: "volume-123",
    });
    isSessionLocked.mockResolvedValue(false);
    deleteSession.mockResolvedValue({
      id: "web:owned",
      user_id: "user-a",
      title: "Owned chat",
      sandbox_id: "sandbox-123",
      workspace_volume_id: "volume-123",
    });
  });

  test("cleans owned remote resources before deleting the session row", async () => {
    const { deleteChatBranch } = await import("./web-adapter.ts");
    const cleanupSessionResources = mock(async () => {});

    await deleteChatBranch("web:owned", "user-a", cleanupSessionResources);

    expect(cleanupSessionResources).toHaveBeenCalledWith({
      id: "web:owned",
      sandbox_id: "sandbox-123",
      workspace_volume_id: "volume-123",
    });
    expect(deleteSession).toHaveBeenCalledWith("web:owned", "user-a");
    expect(cleanupSessionResources.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSession.mock.invocationCallOrder[0],
    );
  });

  test("does not delete the database row when remote cleanup fails", async () => {
    const { deleteChatBranch } = await import("./web-adapter.ts");
    const cleanupSessionResources = mock(async () => {
      throw new Error("sandbox deletion failed");
    });

    await expect(deleteChatBranch("web:owned", "user-a", cleanupSessionResources)).rejects.toThrow(
      "sandbox deletion failed",
    );

    expect(deleteSession).not.toHaveBeenCalled();
  });

  test("does not clean resources from another user's session", async () => {
    getSessionForUser.mockResolvedValueOnce(null);
    const { deleteChatBranch } = await import("./web-adapter.ts");
    const cleanupSessionResources = mock(async () => {});

    await expect(deleteChatBranch("web:other-user", "user-a", cleanupSessionResources)).rejects.toThrow(
      "Unknown chat branch",
    );

    expect(cleanupSessionResources).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
