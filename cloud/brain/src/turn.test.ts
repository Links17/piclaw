import { beforeEach, describe, expect, mock, test } from "bun:test";

const removeFollowupByMessageId = mock(async () => ({ content: "steer this", messageId: 42 }));
const listQueuedFollowupItems = mock(async () => []);
const tryLockSession = mock(async () => null);
const publish = mock(async () => {});
const enqueueSessionSteerMessage = mock(async () => {});
const getInflightTurn = mock(() => "41");
const getCursor = mock(async () => ({ inflight_message_id: 41 }));
const clearInflight = mock(async () => {});

mock.module("@piclaw-cloud/store", () => ({
  UNTITLED_SESSION_TITLE: "New chat",
  tryLockSession,
  removeFollowupByMessageId,
  listQueuedFollowupItems,
  getCursor,
  clearInflight,
}));
mock.module("@piclaw-cloud/store/db", () => ({
  newCounter: () => ({ count: 0 }),
}));
mock.module("./events.ts", () => ({ publish }));
mock.module("./agent-run-state.ts", () => ({
  getInflightTurn,
  getDraft: () => "",
  getPlanPreview: () => "",
  setInflightTurn: () => {},
  clearInflightTurn: () => {},
  appendDraft: () => {},
  setPlanPreview: () => {},
  getContextUsage: () => null,
  setContextUsage: () => {},
  trackTurnDelta: () => {},
  trackTurnFinished: () => {},
  trackTurnStarted: () => {},
  clearPendingQuestionState: () => {},
  getPendingQuestionState: () => null,
  setPendingQuestionState: () => {},
}));
mock.module("./subagents/channels.ts", () => ({
  enqueueSessionSteerMessage,
  pollSessionSteerMessage: async () => null,
  pollSteerMessage: async () => null,
  enqueueSteerMessage: async () => {},
  clearSteerQueue: async () => {},
  clearSessionSteerQueue: async () => {},
  waitForSubagentCompletion: async () => false,
  notifySubagentCompletion: async () => {},
}));

describe("steerQueuedFollowup", () => {
  beforeEach(() => {
    removeFollowupByMessageId.mockClear();
    listQueuedFollowupItems.mockClear();
    tryLockSession.mockClear();
    publish.mockClear();
    enqueueSessionSteerMessage.mockClear();
    getInflightTurn.mockClear();
    removeFollowupByMessageId.mockResolvedValue({ content: "steer this", messageId: 42 });
    listQueuedFollowupItems.mockResolvedValue([]);
    tryLockSession.mockResolvedValue(null);
    getInflightTurn.mockReturnValue("41");
  });

  test("removes a queued follow-up and injects it into the active turn", async () => {
    const { steerQueuedFollowup } = await import("./turn.ts");

    const result = await steerQueuedFollowup("web:active", 42);

    expect(removeFollowupByMessageId).toHaveBeenCalledWith("web:active", 42, expect.anything());
    expect(enqueueSessionSteerMessage).toHaveBeenCalledWith("web:active", "steer this");
    expect(publish).toHaveBeenCalledWith("web:active", { type: "followup_removed", messageId: 42 });
    expect(publish).toHaveBeenCalledWith(
      "web:active",
      expect.objectContaining({ type: "steer_applied", content: "steer this" }),
    );
    expect(tryLockSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      removed: true,
      row_id: 42,
      queued: "steer",
      count: 0,
      user_message: { id: 42, content: "steer this" },
    });
  });
});

describe("abortSessionTurn", () => {
  test("invalidates the durable inflight cursor before returning", async () => {
    const { abortSessionTurn } = await import("./turn.ts");

    await abortSessionTurn("web:active");

    expect(clearInflight).toHaveBeenCalledWith("web:active");
  });
});
