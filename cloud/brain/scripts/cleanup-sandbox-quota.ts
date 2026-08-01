/**
 * Reclaim sandbox quota — pause/delete orphaned CubeSandbox VMs and clear PG bindings.
 * Safe for dev/E2E: targets test session id prefixes and sessions idle > 1h.
 */
import * as store from "@piclaw-cloud/store";
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { applyMigrations, sql } from "@piclaw-cloud/store/db";
import { applyE2bEnv } from "../src/sandbox/config.ts";
import { cubeFetch, getAccessToken } from "../src/sandbox/auth.ts";
import { deleteWorkspaceVolume } from "../src/sandbox/volume.ts";

applyE2bEnv();

const TEST_PREFIXES = [
  "e2e",
  "llm-e2e",
  "llm-subagent-e2e",
  "web-e2e",
  "real-e2e",
  "terminal-reconnect-e2e",
  "debug-",
  "e2e-manual",
];
const idleMs = Number(process.env.CLOUD_CLEANUP_IDLE_MS || 60 * 60 * 1000);
const dryRun = process.env.CLOUD_CLEANUP_DRY_RUN === "1";

function isTestSession(id: string): boolean {
  return TEST_PREFIXES.some((p) => id.startsWith(p)) || id.startsWith("web:");
}

async function deleteRemoteSandbox(sandboxId: string): Promise<boolean> {
  const res = await cubeFetch(`/sandboxes/${sandboxId}`, { method: "DELETE" });
  return res.ok || res.status === 404;
}

await applyMigrations();
await getAccessToken();

const rows = await sql`
  SELECT id, sandbox_id, workspace_volume_id, last_active_at
  FROM sessions
  WHERE sandbox_id IS NOT NULL OR workspace_volume_id IS NOT NULL`;

let cleared = 0;
const activeBefore = await store.countActiveSandboxes("default-user");
const forceAll = activeBefore >= Number(process.env.CLOUD_MAX_ACTIVE_SANDBOXES || getCloudConfig().subagent.maxActiveSandboxesPerUser);

for (const row of rows as Array<{
  id: string;
  sandbox_id: string | null;
  workspace_volume_id: string | null;
  last_active_at: string;
}>) {
  const idle = Date.now() - new Date(String(row.last_active_at)).getTime();
  const shouldClear = forceAll || isTestSession(row.id) || idle > idleMs;
  if (!shouldClear) continue;

  if (!dryRun) {
    const sandboxDeleted = !row.sandbox_id || await deleteRemoteSandbox(row.sandbox_id).catch(() => false);
    const volumeDeleted = sandboxDeleted && (
      !row.workspace_volume_id || await deleteWorkspaceVolume(row.workspace_volume_id).catch(() => false)
    );
    if (!sandboxDeleted || !volumeDeleted) {
      console.error(`failed to clear ${row.id}: sandbox=${sandboxDeleted} volume=${volumeDeleted}`);
      continue;
    }
    await sql`
      UPDATE sessions
      SET sandbox_id = NULL,
          workspace_volume_id = NULL,
          sandbox_paused_at = NULL,
          updated_at = now()
      WHERE id = ${row.id}`;
  }
  cleared += 1;
  console.log(`${dryRun ? "[dry-run] " : ""}cleared ${row.id} → ${row.sandbox_id?.slice(0, 8) ?? "no-sandbox"}`);
}

const remaining = await store.countActiveSandboxes("default-user");
console.log(`cleanup done: cleared=${cleared} active_sandboxes(default-user)=${remaining}`);
await sql.end();
