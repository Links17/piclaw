import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { QuotaExceededError } from "../quota.ts";
import { cubeFetch } from "./auth.ts";
import { connectSandbox, createSandbox, type Sandbox } from "./client.ts";

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

  const sbx = session.sandbox_id
    ? await connectSandbox(session.sandbox_id)
    : await createSandbox();

  if (!session.sandbox_id) {
    await store.setSandboxId(sessionId, sbx.sandboxId);
  } else {
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
