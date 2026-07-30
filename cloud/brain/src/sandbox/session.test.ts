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

mock.module("./client.ts", () => ({
  connectSandbox,
  createSandbox,
  SandboxUnavailableError: MockSandboxUnavailableError,
}));

const getSession = mock(async () => ({
  id: "web:default",
  user_id: "default-user",
  sandbox_id: "stale-id",
}));
const checkQuota = mock(async () => ({ ok: true }));
const clearSandboxId = mock(async () => {});
const setSandboxId = mock(async () => {});
const clearSandboxPaused = mock(async () => {});

mock.module("@piclaw-cloud/store", () => ({
  getSession,
  checkQuota,
  clearSandboxId,
  setSandboxId,
  clearSandboxPaused,
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
    getSession.mockClear();
    clearSandboxId.mockClear();
    setSandboxId.mockClear();
    clearSandboxPaused.mockClear();
  });

  test("recreates sandbox when connect returns not_found", async () => {
    const { ensureSandbox, dropLiveSandbox } = await import("./session.ts");
    dropLiveSandbox("web:default");

    const sbx = await ensureSandbox("web:default");

    expect(connectSandbox).toHaveBeenCalledWith("stale-id");
    expect(clearSandboxId).toHaveBeenCalledWith("web:default");
    expect(createSandbox).toHaveBeenCalled();
    expect(setSandboxId).toHaveBeenCalledWith("web:default", "fresh-sandbox-id");
    expect(sbx.sandboxId).toBe("fresh-sandbox-id");
  });
});
