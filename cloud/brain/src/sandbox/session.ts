import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { QuotaExceededError } from "../quota.ts";
import { cubeFetch } from "./auth.ts";
import {
  connectSandbox,
  createSandbox,
  createWorkspaceVolume,
  SandboxUnavailableError,
  type Sandbox,
} from "./client.ts";

const live = new Map<string, Sandbox>();

async function assertSandboxQuota(sessionId: string): Promise<void> {
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
  if (!session.sandbox_id && !quota.ok && quota.reason === "active_sandbox_limit") {
    throw new QuotaExceededError(
      "active_sandboxes",
      config.maxActiveSandboxesPerUser,
      quota.activeSandboxes ?? 0,
    );
  }
}

async function ensureWorkspaceVolume(sessionId: string): Promise<string | undefined> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const existing = typeof session.workspace_volume_id === "string"
    ? session.workspace_volume_id.trim()
    : "";
  if (existing) return existing;

  try {
    const volumeId = await createWorkspaceVolume(sessionId);
    await store.setWorkspaceVolumeId(sessionId, volumeId);
    return volumeId;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[sandbox] workspace volume unavailable for ${sessionId}: ${detail}`);
    return undefined;
  }
}

async function clearStaleSandboxBinding(sessionId: string, staleSandboxId: string): Promise<void> {
  console.warn(`[sandbox] stale sandbox_id cleared for ${sessionId}: ${staleSandboxId.slice(0, 12)}…`);
  dropLiveSandbox(sessionId);
  await store.clearSandboxId(sessionId);
}

async function recreateSandboxWithVolume(sessionId: string, volumeId?: string): Promise<Sandbox> {
  const sbx = await createSandbox({ volumeId: volumeId ?? null });
  await store.setSandboxId(sessionId, sbx.sandboxId);
  live.set(sessionId, sbx);
  return sbx;
}

async function connectOrRecreate(
  sessionId: string,
  sandboxId: string,
  volumeId?: string,
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
  await assertSandboxQuota(sessionId);
  const cached = live.get(sessionId);
  if (cached) return cached;

  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const volumeId = await ensureWorkspaceVolume(sessionId);

  const sbx = session.sandbox_id
    ? await connectOrRecreate(sessionId, session.sandbox_id, volumeId)
    : await recreateSandboxWithVolume(sessionId, volumeId);

  if (!session.sandbox_id) {
    await store.setSandboxId(sessionId, sbx.sandboxId);
  } else if (!live.has(sessionId)) {
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
  return { sandbox: sbx, pid: terminal.pid };
}

export function getLiveSandbox(sessionId: string): Sandbox | undefined {
  return live.get(sessionId);
}

export function dropLiveSandbox(sessionId: string): void {
  live.delete(sessionId);
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
    await store.markSandboxPaused(sessionId);
    return true;
  } catch {
    return false;
  }
}
