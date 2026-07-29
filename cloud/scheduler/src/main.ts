/**
 * Scheduler worker — pause idle session sandboxes to reduce cost.
 */
import * as store from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";

const idleMs = Number(process.env.CLOUD_SANDBOX_IDLE_MS || 30 * 60 * 1000);
const pollMs = Number(process.env.CLOUD_SCHEDULER_POLL_MS || 60_000);

const sandboxApiUrl = process.env.CUBE_API_URL || process.env.CLOUD_SANDBOX_API_URL || "";
const sandboxApiKey = process.env.CUBE_API_KEY || process.env.CLOUD_SANDBOX_API_KEY || "";
const sandboxOpsUrl = process.env.CUBE_OPS_URL || process.env.CLOUD_SANDBOX_OPS_URL || "";
const sandboxOpsUser = process.env.CUBE_OPS_USER || process.env.CLOUD_SANDBOX_OPS_USER || "";
const sandboxOpsPassword = process.env.CUBE_OPS_PASSWORD || process.env.CLOUD_SANDBOX_OPS_PASSWORD || "";

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!sandboxOpsUrl || !sandboxOpsUser || !sandboxOpsPassword) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.value;
  }
  const res = await fetch(`${sandboxOpsUrl.replace(/\/$/, "")}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: sandboxOpsUser, password: sandboxOpsPassword }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { accessToken: string; expiresInSecs?: number };
  cachedToken = {
    value: body.accessToken,
    expiresAt: Date.now() + (body.expiresInSecs ?? 900) * 1000,
  };
  return cachedToken.value;
}

async function pauseSandbox(sandboxId: string): Promise<boolean> {
  if (!sandboxApiUrl || !sandboxApiKey) return false;
  const token = await getAccessToken();
  if (!token) return false;
  const res = await fetch(`${sandboxApiUrl.replace(/\/$/, "")}/sandboxes/${sandboxId}/pause`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-API-KEY": sandboxApiKey,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  return res.ok || res.status === 404;
}

async function sweepIdleSandboxes(): Promise<void> {
  const idle = await store.listIdleSessions(idleMs);
  for (const row of idle) {
    const paused = await pauseSandbox(row.sandbox_id);
    if (paused) {
      await store.markSandboxPaused(row.id);
      console.log(`[scheduler] paused sandbox for session ${row.id}`);
    }
  }
}

await applyMigrations();
console.log(`[scheduler] idle=${idleMs}ms poll=${pollMs}ms`);
await sweepIdleSandboxes();
setInterval(() => {
  sweepIdleSandboxes().catch((error) => {
    console.error("[scheduler] sweep failed:", error);
  });
}, pollMs);
