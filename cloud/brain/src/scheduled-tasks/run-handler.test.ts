import { beforeEach, describe, expect, mock, test } from "bun:test";

const getClaimedInternalScheduledTask = mock(async () => ({
  id: "task-a",
  session_id: "session-a",
  prompt: "internal:dream",
  schedule_type: "once",
  schedule_value: "",
}));
const beginScheduledTaskExecution = mock(async () => false);
const executeInternalScheduledTask = mock(async () => ({ ok: true, summary: "done" }));

mock.module("@piclaw-cloud/store", () => ({
  getClaimedInternalScheduledTask,
  beginScheduledTaskExecution,
}));
mock.module("./execute-internal.ts", () => ({ executeInternalScheduledTask }));

describe("internal scheduled task execution", () => {
  beforeEach(async () => {
    beginScheduledTaskExecution.mockReset();
    beginScheduledTaskExecution.mockResolvedValue(false);
    executeInternalScheduledTask.mockReset();
    executeInternalScheduledTask.mockResolvedValue({ ok: true, summary: "done" });
    const { resetOperationsForTest } = await import("../operations.ts");
    resetOperationsForTest();
  });

  test("requires scheduler service authentication", async () => {
    const { handleInternalScheduledTaskExecute } = await import("./run-handler.ts");
    const response = await handleInternalScheduledTaskExecute(
      new Request("http://brain.test/internal/scheduled-tasks/execute", {
        method: "POST",
        body: JSON.stringify({ id: "task-a", session_id: "session-a", claim_token: "claim-a" }),
      }),
      "service-key",
    );
    expect(response.status).toBe(401);
    expect(beginScheduledTaskExecution).not.toHaveBeenCalled();
  });

  test("rejects a placeholder scheduler key", async () => {
    const { handleInternalScheduledTaskExecute } = await import("./run-handler.ts");
    const placeholder = "replace-with-a-shared-internal-service-key";
    const response = await handleInternalScheduledTaskExecute(
      new Request("http://brain.test/internal/scheduled-tasks/execute", {
        method: "POST",
        headers: { "X-Piclaw-Service-Key": placeholder },
        body: JSON.stringify({ id: "task-a", session_id: "session-a", claim_token: "claim-a" }),
      }),
      placeholder,
    );
    expect(response.status).toBe(401);
  });

  test("rejects a duplicate execution marker before side effects", async () => {
    const { handleInternalScheduledTaskExecute } = await import("./run-handler.ts");
    const response = await handleInternalScheduledTaskExecute(
      new Request("http://brain.test/internal/scheduled-tasks/execute", {
        method: "POST",
        headers: { "X-Piclaw-Service-Key": "service-key" },
        body: JSON.stringify({ id: "task-a", session_id: "session-a", claim_token: "claim-a" }),
      }),
      "service-key",
    );
    expect(response.status).toBe(409);
    expect(executeInternalScheduledTask).not.toHaveBeenCalled();
  });

  test("tracks the internal operation until execution truly finishes", async () => {
    beginScheduledTaskExecution.mockResolvedValue(true);
    let release!: () => void;
    executeInternalScheduledTask.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, summary: "done" });
    }));
    const { getActiveOperationCounts } = await import("../operations.ts");
    const { handleInternalScheduledTaskExecute } = await import("./run-handler.ts");

    const pending = handleInternalScheduledTaskExecute(
      new Request("http://brain.test/internal/scheduled-tasks/execute", {
        method: "POST",
        headers: { "X-Piclaw-Service-Key": "service-key" },
        body: JSON.stringify({ id: "task-a", session_id: "session-a", claim_token: "claim-a" }),
      }),
      "service-key",
    );
    await Bun.sleep(0);

    expect(getActiveOperationCounts()).toEqual({ scheduled_internal: 1 });
    release();
    expect((await pending).status).toBe(200);
    expect(getActiveOperationCounts()).toEqual({});
  });
});
