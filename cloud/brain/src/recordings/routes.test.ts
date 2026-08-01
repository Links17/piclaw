import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSessionForUser = mock(async () => null as any);
const startSessionRecording = mock(async () => ({
  id: "recording-a",
  chatJid: "session-a",
  title: "Recording",
  mode: "metadata",
  status: "recording",
  startedAt: new Date().toISOString(),
  eventCount: 1,
  tracePath: "pg://recording-a",
}));
const getTimeline = mock(async () => ({ posts: [{ id: 1 }] }));

mock.module("@piclaw-cloud/store", () => ({ getSessionForUser }));
mock.module("./service.ts", () => ({
  startSessionRecording,
  getActiveSessionRecording: async () => null,
  listSessionRecordings: async () => [],
  listActiveSessionRecordings: async () => [],
  previewSessionRecordingRedaction: () => ({}),
  recordSessionFixtureNote: async () => {},
  recordTimelineInteraction: async () => {},
  stopSessionRecording: async () => null,
  getSessionRecording: async () => null,
  deleteSessionRecording: async () => false,
}));

describe("recording route ownership", () => {
  beforeEach(() => {
    getSessionForUser.mockClear();
    startSessionRecording.mockClear();
    getTimeline.mockClear();
  });

  test("rejects recording start for another user's session before snapshot read", async () => {
    const { handleSessionRecordingRoutes } = await import("./routes.ts");
    getSessionForUser.mockResolvedValueOnce(null);
    const response = await handleSessionRecordingRoutes(
      new Request("http://brain.test/agent/recordings/start", {
        method: "POST",
        body: JSON.stringify({
          chat_jid: "session-b",
          include_timeline_snapshot: true,
        }),
      }),
      "/agent/recordings/start",
      "user-a",
      getTimeline,
      getSessionForUser,
    );
    expect(response?.status).toBe(401);
    expect(startSessionRecording).not.toHaveBeenCalled();
    expect(getTimeline).not.toHaveBeenCalled();
  });

  test("starts and snapshots only an owned session", async () => {
    const { handleSessionRecordingRoutes } = await import("./routes.ts");
    getSessionForUser.mockResolvedValueOnce({ id: "session-a", user_id: "user-a" });
    const response = await handleSessionRecordingRoutes(
      new Request("http://brain.test/agent/recordings/start", {
        method: "POST",
        body: JSON.stringify({
          chat_jid: "session-a",
          include_timeline_snapshot: true,
        }),
      }),
      "/agent/recordings/start",
      "user-a",
      getTimeline,
      getSessionForUser,
    );
    expect(response?.status).toBe(201);
    expect(startSessionRecording).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: "session-a",
      userId: "user-a",
    }));
    expect(getTimeline).toHaveBeenCalledWith("session-a", 50);
  });
});
