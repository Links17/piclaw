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
const deleteRemoteSandbox = mock(async () => true);
const deleteWorkspaceVolume = mock(async () => true);
const cubeFetch = mock(async () => new Response("", { status: 200 }));

mock.module("./client.ts", () => ({
  connectSandbox,
  createSandbox,
  createWorkspaceVolume,
  deleteRemoteSandbox,
  deleteWorkspaceVolume,
  SandboxUnavailableError: MockSandboxUnavailableError,
}));
mock.module("./auth.ts", () => ({ cubeFetch }));

type MockSession = {
  id: string;
  user_id: string;
  sandbox_id: string | null;
  workspace_volume_id: string | null;
  sandbox_paused_at?: string | null;
};

const getSession = mock<() => Promise<MockSession>>(async () => ({
  id: "web:default",
  user_id: "default-user",
  sandbox_id: "stale-id",
  workspace_volume_id: "volume-123",
}));
const checkQuota = mock(async () => ({ ok: true }));
const clearSandboxId = mock(async () => {});
const setSandboxId = mock(async () => {});
const reserveSandboxQuota = mock(async () => ({ reserved: true, activeSandboxes: 1 }));
const releaseSandboxQuotaReservation = mock(async () => {});
const setWorkspaceVolumeId = mock(async () => {});
const clearSandboxPaused = mock(async () => {});
const clearTerminalPid = mock(async () => {});
const countRunningSubagents = mock(async () => 0);
const markSandboxPaused = mock(async () => {});
const createMedia = mock(async () => 42);
const getMediaByIdForUser = mock(async () => ({
  id: 42,
  user_id: "default-user",
  filename: "demo.bin",
  content_type: "application/octet-stream",
  object_key: "media/default-user/42/demo.bin",
  thumbnail_object_key: null,
  data: undefined,
  thumbnail: null,
  metadata: null,
  created_at: "2026-01-01T00:00:00.000Z",
}));
const getMediaInfoByIdForUser = mock(async () => ({
  id: 42,
  filename: "demo.bin",
  content_type: "application/octet-stream",
  size: 4,
  has_thumbnail: false,
  created_at: "2026-01-01T00:00:00.000Z",
}));

mock.module("@piclaw-cloud/store", () => ({
  getSession,
  checkQuota,
  clearSandboxId,
  setSandboxId,
  reserveSandboxQuota,
  releaseSandboxQuotaReservation,
  setWorkspaceVolumeId,
  clearSandboxPaused,
  clearTerminalPid,
  countRunningSubagents,
  markSandboxPaused,
  createMedia,
  getMediaByIdForUser,
  getMediaInfoByIdForUser,
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
    deleteRemoteSandbox.mockClear();
    deleteWorkspaceVolume.mockClear();
    getSession.mockClear();
    clearSandboxId.mockClear();
    setSandboxId.mockClear();
    reserveSandboxQuota.mockClear();
    releaseSandboxQuotaReservation.mockClear();
    setWorkspaceVolumeId.mockClear();
    clearSandboxPaused.mockClear();
    clearTerminalPid.mockClear();
    countRunningSubagents.mockClear();
    markSandboxPaused.mockClear();
    cubeFetch.mockClear();
    getSession.mockResolvedValue({
      id: "web:default",
      user_id: "default-user",
      sandbox_id: "stale-id",
      workspace_volume_id: "volume-123",
    });
    countRunningSubagents.mockResolvedValue(0);
    reserveSandboxQuota.mockResolvedValue({ reserved: true, activeSandboxes: 1 });
    deleteRemoteSandbox.mockResolvedValue(true);
    deleteWorkspaceVolume.mockResolvedValue(true);
    connectSandbox.mockRejectedValue(
      new MockSandboxUnavailableError("stale-id", "not_found", "GET /sandboxes/stale-id → 404"),
    );
    createSandbox.mockResolvedValue({ sandboxId: "fresh-sandbox-id" });
    createWorkspaceVolume.mockResolvedValue("volume-123");
  });

  test("recreates sandbox with session volume when connect returns not_found", async () => {
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");

    const sbx = await ensureSandbox("web:default");

    expect(connectSandbox).toHaveBeenCalledWith("stale-id");
    expect(countRunningSubagents).toHaveBeenCalledWith("web:default");
    expect(clearSandboxId).toHaveBeenCalledWith("web:default");
    expect(reserveSandboxQuota).toHaveBeenCalledWith("web:default", 10);
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

  test("releases the atomic quota reservation if sandbox creation fails", async () => {
    createSandbox.mockRejectedValueOnce(new Error("sandbox create failed"));
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");

    await expect(ensureSandbox("web:default")).rejects.toThrow("sandbox create failed");
    expect(releaseSandboxQuotaReservation).toHaveBeenCalledWith("web:default");
  });

  test("pauses the volume-backed sandbox without copying workspace files", async () => {
    const sandbox = {
      sandboxId: "stale-id",
      commands: {
        run: mock(async () => ({ exitCode: 0, stdout: "AQID", stderr: "" })),
      },
    };
    getSession.mockResolvedValue({
      id: "web:default",
      user_id: "default-user",
      sandbox_id: "stale-id",
      workspace_volume_id: "volume-123",
    });
    const { pauseSessionSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");
    connectSandbox.mockResolvedValueOnce(sandbox as never);

    expect(await pauseSessionSandbox("web:default")).toBe(true);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(cubeFetch).toHaveBeenCalledWith("/sandboxes/stale-id/pause", expect.anything());
    expect(markSandboxPaused).toHaveBeenCalledWith("web:default");
    expect(clearTerminalPid).toHaveBeenCalledWith("web:default");
  });

  test("resumes a paused sandbox without copying workspace files", async () => {
    const sandbox = {
      sandboxId: "sandbox-paused",
      commands: {
        run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    };
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");
    getSession.mockResolvedValue({
      id: "web:default",
      user_id: "default-user",
      sandbox_id: "sandbox-paused",
      workspace_volume_id: "volume-123",
      sandbox_paused_at: "2026-07-31T00:00:00.000Z",
    });
    connectSandbox.mockResolvedValueOnce(sandbox as never);
    await ensureSandbox("web:default");

    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  test("deletes the session sandbox before its workspace volume", async () => {
    const { createSessionResourceCleanup, getLiveSandbox } = await import("./session.ts");
    const cleanupSessionResources = createSessionResourceCleanup({
      deleteSandbox: deleteRemoteSandbox,
      deleteVolume: deleteWorkspaceVolume,
    });

    await cleanupSessionResources({
      id: "web:default",
      sandbox_id: "sandbox-123",
      workspace_volume_id: "volume-123",
    });

    expect(deleteRemoteSandbox).toHaveBeenCalledWith("sandbox-123");
    expect(deleteWorkspaceVolume).toHaveBeenCalledWith("volume-123");
    expect(deleteRemoteSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      deleteWorkspaceVolume.mock.invocationCallOrder[0],
    );
    expect(getLiveSandbox("web:default")).toBeUndefined();
  });

  test("continues cleanup when an already absent remote resource returns success", async () => {
    deleteRemoteSandbox.mockResolvedValueOnce(true);
    deleteWorkspaceVolume.mockResolvedValueOnce(true);
    const { createSessionResourceCleanup } = await import("./session.ts");
    const cleanupSessionResources = createSessionResourceCleanup({
      deleteSandbox: deleteRemoteSandbox,
      deleteVolume: deleteWorkspaceVolume,
    });

    await expect(cleanupSessionResources({
      id: "web:default",
      sandbox_id: "sandbox-missing",
      workspace_volume_id: "volume-missing",
    })).resolves.toBeUndefined();

    expect(deleteRemoteSandbox).toHaveBeenCalledWith("sandbox-missing");
    expect(deleteWorkspaceVolume).toHaveBeenCalledWith("volume-missing");
  });

  test("keeps the volume for a retry when sandbox deletion fails", async () => {
    deleteRemoteSandbox.mockResolvedValueOnce(false);
    const { createSessionResourceCleanup } = await import("./session.ts");
    const cleanupSessionResources = createSessionResourceCleanup({
      deleteSandbox: deleteRemoteSandbox,
      deleteVolume: deleteWorkspaceVolume,
    });

    await expect(cleanupSessionResources({
      id: "web:default",
      sandbox_id: "sandbox-123",
      workspace_volume_id: "volume-123",
    })).rejects.toThrow("sandbox deletion failed");

    expect(deleteWorkspaceVolume).not.toHaveBeenCalled();
  });
});
