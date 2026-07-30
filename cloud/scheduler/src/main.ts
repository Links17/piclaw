/**
 * Scheduler worker — pause idle session sandboxes to reduce cost.
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import * as store from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";

const cloud = getCloudConfig();
const idleMs = cloud.sandbox.idleMs;
const pollMs = cloud.scheduler.pollMs;

const sandboxApiUrl = cloud.sandbox.apiUrl;
const sandboxApiKey = cloud.sandbox.apiKey;
const sandboxOpsUrl = cloud.sandbox.opsUrl;
const sandboxOpsUser = cloud.sandbox.opsUser;
const sandboxOpsPassword = cloud.sandbox.opsPassword;

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
