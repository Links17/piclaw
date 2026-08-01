import { describe, expect, mock, test } from "bun:test";

const handleModelSlashCommand = mock(async () => ({
  uiOnly: true,
  command: { status: "success" },
}));

mock.module("./models/service.ts", () => ({ handleModelSlashCommand }));
mock.module("@piclaw-cloud/store", () => ({
  getSession: async () => ({ id: "session-a" }),
}));
mock.module("./turn.ts", () => ({
  submitMessage: async () => ({ outcome: "ran", userMessageId: 0 }),
}));
mock.module("./agent-run-state.ts", () => ({
  abortSessionTurn: async () => {},
}));

describe("model command user flow", () => {
  test("passes authenticated user through sendAgentMessage", async () => {
    const { sendAgentMessage } = await import("./web-adapter.ts");
    await sendAgentMessage("session-a", "/model provider/model-a", null, "user-a");
    expect(handleModelSlashCommand).toHaveBeenCalledWith(
      "session-a",
      "/model provider/model-a",
      "user-a",
    );
  });
});
