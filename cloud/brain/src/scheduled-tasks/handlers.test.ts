import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as actualStore from "@piclaw-cloud/store";

const listScheduledTasksForUser = mock(async () => []);
const getSessionForUser = mock(async () => null);

mock.module("@piclaw-cloud/store", () => ({
  ...actualStore,
  getSessionForUser,
  listScheduledTasksForUser,
}));

describe("scheduled task list handler", () => {
  beforeEach(() => {
    listScheduledTasksForUser.mockReset();
    listScheduledTasksForUser.mockResolvedValue([]);
    getSessionForUser.mockReset();
    getSessionForUser.mockResolvedValue(null);
  });

  test("lists every task owned by the user when no chat filter is supplied", async () => {
    const { handleScheduledTasksList } = await import("./handlers.ts");

    const response = await handleScheduledTasksList(
      new Request("http://brain.test/agent/scheduled-tasks"),
      new URL("http://brain.test/agent/scheduled-tasks"),
      "user-a",
    );

    expect(response.status).toBe(200);
    expect(listScheduledTasksForUser).toHaveBeenCalledWith({
      userId: "user-a",
      sessionId: undefined,
      status: null,
      limit: 50,
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      tasks: [],
      count: 0,
      filters: { chat_jid: null },
    });
  });

  test("requires ownership when filtering tasks to a chat", async () => {
    const { handleScheduledTasksList } = await import("./handlers.ts");

    const response = await handleScheduledTasksList(
      new Request("http://brain.test/agent/scheduled-tasks?chat_jid=session-b"),
      new URL("http://brain.test/agent/scheduled-tasks?chat_jid=session-b"),
      "user-a",
    );

    expect(response.status).toBe(401);
    expect(listScheduledTasksForUser).not.toHaveBeenCalled();
  });
});
