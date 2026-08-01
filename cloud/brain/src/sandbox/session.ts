import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { QuotaExceededError } from "../quota.ts";
import { cubeFetch } from "./auth.ts";
import {
  connectSandbox,
  createSandbox,
  createWorkspaceVolume,
  deleteRemoteSandbox,
  deleteWorkspaceVolume,
  SandboxUnavailableError,
  type Sandbox,
} from "./client.ts";

const live = new Map<string, Sandbox>();

async function assertTurnQuota(sessionId: string): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const quota = await store.checkQuota(session.user_id, {
    maxActiveSandboxes: config.maxActiveSandboxesPerUser,
    maxDailyTokens: config.maxDailyTokensPerUser,
  });
  if (!quota.ok && quota.reason === "daily_token_limit") {
    throw new QuotaExceededError(
      "daily_tokens",
      config.maxDailyTokensPerUser,
      quota.dailyTokens ?? 0,
    );
  }
}

async function ensureWorkspaceVolume(sessionId: string): Promise<string> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const existing = typeof session.workspace_volume_id === "string"
    ? session.workspace_volume_id.trim()
    : "";
  if (existing) return existing;

  const volumeId = await createWorkspaceVolume(sessionId);
  await store.setWorkspaceVolumeId(sessionId, volumeId);
  return volumeId;
}

async function clearStaleSandboxBinding(sessionId: string, staleSandboxId: string): Promise<void> {
  console.warn(`[sandbox] stale sandbox_id cleared for ${sessionId}: ${staleSandboxId.slice(0, 12)}…`);
  dropLiveSandbox(sessionId);
  await store.clearSandboxId(sessionId);
}

async function recreateSandboxWithVolume(sessionId: string, volumeId: string): Promise<Sandbox> {
  const reservation = await store.reserveSandboxQuota(
    sessionId,
    config.maxActiveSandboxesPerUser,
  );
  if (!reservation.reserved) {
    throw new QuotaExceededError(
      "active_sandboxes",
      config.maxActiveSandboxesPerUser,
      reservation.activeSandboxes,
    );
  }

  try {
    const sbx = await createSandbox({ volumeId });
    await store.setSandboxId(sessionId, sbx.sandboxId);
    live.set(sessionId, sbx);
    return sbx;
  } catch (error) {
    await store.releaseSandboxQuotaReservation(sessionId);
    throw error;
  }
}

async function connectOrRecreate(
  sessionId: string,
  sandboxId: string,
  volumeId: string,
): Promise<Sandbox> {
  try {
    return await connectSandbox(sandboxId);
  } catch (error) {
    if (
      error instanceof SandboxUnavailableError
      && (error.code === "not_found" || error.code === "resume_failed")
    ) {
      const runningSubagents = await store.countRunningSubagents(sessionId);
      if (runningSubagents > 0) {
        throw new SandboxUnavailableError(
          sandboxId,
          "platform_error",
          "sandbox unavailable while subagents are running; retry after they finish",
        );
      }
      await clearStaleSandboxBinding(sessionId, sandboxId);
      return recreateSandboxWithVolume(sessionId, volumeId);
    }
    throw error;
  }
}

/** Lazy-create or resume the sandbox bound to a session. */
export async function ensureSandbox(sessionId: string): Promise<Sandbox> {
  if (!config.sandboxEnabled) {
    throw new Error("sandbox disabled (CLOUD_SANDBOX_ENABLED=0)");
  }
  await assertTurnQuota(sessionId);
  const cached = live.get(sessionId);
  if (cached) return cached;

  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const volumeId = await ensureWorkspaceVolume(sessionId);

  const wasPaused = Boolean(session.sandbox_paused_at);
  const reconnectingExistingSandbox = Boolean(session.sandbox_id);
  const sbx = session.sandbox_id
    ? await connectOrRecreate(sessionId, session.sandbox_id, volumeId)
    : await recreateSandboxWithVolume(sessionId, volumeId);

  if (!reconnectingExistingSandbox) {
    await store.setSandboxId(sessionId, sbx.sandboxId);
  } else if (wasPaused || !live.has(sessionId)) {
    await store.clearSandboxPaused(sessionId);
  }
  live.set(sessionId, sbx);
  return sbx;
}

export async function runBash(sessionId: string, command: string): Promise<string> {
  const sbx = await ensureSandbox(sessionId);
  const result = await sbx.commands.run(command, { timeoutMs: 120_000 });
  const parts = [`$ ${command}`];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.exitCode})`);
  return parts.join("\n");
}

/** PTY attach for terminal WebSocket — returns pid + sandbox handle. */
export async function createTerminal(sessionId: string): Promise<{ sandbox: Sandbox; pid: number }> {
  const sbx = await ensureSandbox(sessionId);
  const terminal = await sbx.pty.create({ cols: 80, rows: 24, timeoutMs: 60_000, onData: () => {} });
  await store.setTerminalPid(sessionId, terminal.pid);
  return { sandbox: sbx, pid: terminal.pid };
}

export function getLiveSandbox(sessionId: string): Sandbox | undefined {
  return live.get(sessionId);
}

export function dropLiveSandbox(sessionId: string): void {
  live.delete(sessionId);
}

export function createSessionResourceCleanup(deps: {
  deleteSandbox: (sandboxId: string) => Promise<boolean>;
  deleteVolume: (volumeId: string) => Promise<boolean>;
}) {
  return async (resource: {
    id: string;
    sandbox_id?: string | null;
    workspace_volume_id?: string | null;
  }): Promise<void> => {
    dropLiveSandbox(resource.id);

    const sandboxId = typeof resource.sandbox_id === "string" ? resource.sandbox_id.trim() : "";
    const volumeId = typeof resource.workspace_volume_id === "string"
      ? resource.workspace_volume_id.trim()
      : "";

    if (sandboxId && !(await deps.deleteSandbox(sandboxId))) {
      throw new Error(`sandbox deletion failed: ${sandboxId}`);
    }
    if (volumeId && !(await deps.deleteVolume(volumeId))) {
      throw new Error(`workspace volume deletion failed: ${volumeId}`);
    }
  };
}

export async function cleanupSessionResources(resource: {
  id: string;
  sandbox_id?: string | null;
  workspace_volume_id?: string | null;
}): Promise<void> {
  await createSessionResourceCleanup({
    deleteSandbox: deleteRemoteSandbox,
    deleteVolume: deleteWorkspaceVolume,
  })(resource);
}

export async function pauseSessionSandbox(sessionId: string): Promise<boolean> {
  const session = await store.getSession(sessionId);
  if (!session?.sandbox_id) return false;
  try {
    live.delete(sessionId);
    const res = await cubeFetch(`/sandboxes/${session.sandbox_id}/pause`, { method: "POST", body: "{}" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`pause failed: ${res.status}`);
    }
    // A paused CubeSandbox does not retain PTYs. Clear the stale PID so the
    // next terminal attachment creates a fresh PTY in the resumed sandbox.
    await store.clearTerminalPid(sessionId);
    await store.markSandboxPaused(sessionId);
    return true;
  } catch {
    return false;
  }
}
