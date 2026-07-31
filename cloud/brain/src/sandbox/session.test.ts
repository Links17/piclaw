import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockSandboxUnavailableError extends Error {
  readonly sandboxId: string;
  readonly code: "not_found" | "resume_failed" | "unreachable" | "platform_error";
  readonly detail: string;

  constructor(
    sandboxId: string,
    code: "not_found" | "resume_failed" | "unreachable" | "platform_error",
    detail: string,
  ) {
    super(`sandbox unavailable (${code}): ${detail}`);
    this.name = "SandboxUnavailableError";
    this.sandboxId = sandboxId;
    this.code = code;
    this.detail = detail;
  }
}

const connectSandbox = mock(async () => {
  throw new MockSandboxUnavailableError("stale-id", "not_found", "GET /sandboxes/stale-id → 404");
});
const createSandbox = mock(async () => ({ sandboxId: "fresh-sandbox-id" }));
const createWorkspaceVolume = mock(async () => "volume-123");

mock.module("./client.ts", () => ({
  connectSandbox,
  createSandbox,
  createWorkspaceVolume,
  SandboxUnavailableError: MockSandboxUnavailableError,
}));

const getSession = mock(async () => ({
  id: "web:default",
  user_id: "default-user",
  sandbox_id: "stale-id",
  workspace_volume_id: "volume-123",
}));
const checkQuota = mock(async () => ({ ok: true }));
const clearSandboxId = mock(async () => {});
const setSandboxId = mock(async () => {});
const setWorkspaceVolumeId = mock(async () => {});
const clearSandboxPaused = mock(async () => {});
const countRunningSubagents = mock(async () => 0);

mock.module("@piclaw-cloud/store", () => ({
  getSession,
  checkQuota,
  clearSandboxId,
  setSandboxId,
  setWorkspaceVolumeId,
  clearSandboxPaused,
  countRunningSubagents,
}));

mock.module("../config.ts", () => ({
  config: {
    sandboxEnabled: true,
    maxActiveSandboxesPerUser: 10,
    maxDailyTokensPerUser: 500_000,
  },
}));

describe("ensureSandbox stale recovery", () => {
  beforeEach(() => {
    connectSandbox.mockClear();
    createSandbox.mockClear();
    createWorkspaceVolume.mockClear();
    getSession.mockClear();
    clearSandboxId.mockClear();
    setSandboxId.mockClear();
    setWorkspaceVolumeId.mockClear();
    clearSandboxPaused.mockClear();
    countRunningSubagents.mockClear();
    getSession.mockResolvedValue({
      id: "web:default",
      user_id: "default-user",
      sandbox_id: "stale-id",
      workspace_volume_id: "volume-123",
    });
    countRunningSubagents.mockResolvedValue(0);
  });

  test("recreates sandbox with session volume when connect returns not_found", async () => {
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");

    const sbx = await ensureSandbox("web:default");

    expect(connectSandbox).toHaveBeenCalledWith("stale-id");
    expect(countRunningSubagents).toHaveBeenCalledWith("web:default");
    expect(clearSandboxId).toHaveBeenCalledWith("web:default");
    expect(createSandbox).toHaveBeenCalledWith({ volumeId: "volume-123" });
    expect(setSandboxId).toHaveBeenCalledWith("web:default", "fresh-sandbox-id");
    expect(sbx.sandboxId).toBe("fresh-sandbox-id");
  });

  test("does not recreate sandbox while subagents are running", async () => {
    countRunningSubagents.mockResolvedValue(1);
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");

    await expect(ensureSandbox("web:default")).rejects.toThrow(/subagents are running/);
    expect(createSandbox).not.toHaveBeenCalled();
  });
});
