/**
 * Scheduler worker — pause idle session sandboxes to reduce cost.
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import * as store from "@piclaw-cloud/store";
import { computeNextRun } from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";
import { canClaimScheduledTasks } from "./service-auth.ts";

const cloud = getCloudConfig();
const idleMs = cloud.sandbox.idleMs;
const pollMs = cloud.scheduler.pollMs;
const schedulerServiceKey = cloud.scheduler.serviceKey;
const scheduledLeaseMs = cloud.scheduler.leaseMs;
const scheduledHeartbeatMs = cloud.scheduler.heartbeatMs;
const idlePauseLeaseMs = cloud.scheduler.idlePauseLeaseMs;

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

async function setSandboxPaused(sandboxId: string, paused: boolean, signal?: AbortSignal): Promise<boolean> {
  if (!sandboxApiUrl || !sandboxApiKey) return false;
  const token = await getAccessToken();
  if (!token) return false;
  const action = paused ? "pause" : "resume";
  const res = await fetch(`${sandboxApiUrl.replace(/\/$/, "")}/sandboxes/${sandboxId}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-API-KEY": sandboxApiKey,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal,
  });
  return res.ok || res.status === 404;
}

async function sweepIdleSandboxes(): Promise<void> {
  const idle = await store.claimIdleSessionsForPause(idleMs, 50, idlePauseLeaseMs);
  for (const row of idle) {
    const controller = new AbortController();
    let leaseLost = false;
    let pendingRenewal: Promise<void> | null = null;
    const heartbeatMs = Math.min(scheduledHeartbeatMs, Math.max(1, Math.floor(idlePauseLeaseMs / 3)));
    const heartbeat = setInterval(() => {
      if (pendingRenewal || controller.signal.aborted) return;
      pendingRenewal = store.renewIdleSessionPauseClaim(
        row.id,
        row.pause_claim_token,
        idlePauseLeaseMs,
        idleMs,
      ).then((renewed) => {
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("idle pause claim lease lost"));
        }
      }).catch((error) => {
        leaseLost = true;
        controller.abort(error);
      }).finally(() => {
        pendingRenewal = null;
      });
    }, heartbeatMs);
    let pausedExternally = false;
    try {
      if (!(await store.validateIdleSessionPauseClaim(row.id, row.pause_claim_token, idleMs))) continue;
      pausedExternally = await setSandboxPaused(row.sandbox_id, true, controller.signal);
      const stillValid = !leaseLost
        && await store.validateIdleSessionPauseClaim(row.id, row.pause_claim_token, idleMs);
      if (pausedExternally && stillValid && await store.completeIdleSessionPauseClaim(row.id, row.pause_claim_token)) {
        console.log(JSON.stringify({
          level: "info",
          event: "scheduler_idle_sandbox_paused",
          sessionId: row.id,
          sandboxId: row.sandbox_id,
        }));
      } else {
        if (pausedExternally) {
          const resumed = await setSandboxPaused(row.sandbox_id, false);
          console.warn(JSON.stringify({
            level: resumed ? "warn" : "error",
            event: "scheduler_idle_pause_compensated",
            sessionId: row.id,
            compensated: resumed,
          }));
        }
        await store.failIdleSessionPauseClaim(row.id, row.pause_claim_token);
      }
    } catch (error) {
      if (pausedExternally) await setSandboxPaused(row.sandbox_id, false).catch(() => false);
      await store.failIdleSessionPauseClaim(row.id, row.pause_claim_token);
      console.error(JSON.stringify({
        level: "error",
        event: "scheduler_idle_pause_failed",
        sessionId: row.id,
        leaseLost,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      clearInterval(heartbeat);
      const renewal = pendingRenewal as Promise<void> | null;
      await renewal?.catch(() => {});
    }
  }
}

async function withScheduledClaimHeartbeat<T>(
  task: store.ClaimedScheduledTask,
  fn: (isLeaseLost: () => boolean, signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; leaseLost: boolean }> {
  let leaseLost = false;
  let renewing = false;
  const renew = async () => {
    if (renewing || leaseLost) return;
    renewing = true;
    try {
      leaseLost = !(await store.renewScheduledTaskClaim(task.id, task.claim_token, scheduledLeaseMs));
    } catch {
      leaseLost = true;
    } finally {
      renewing = false;
    }
  };
  const controller = new AbortController();
  let pendingRenewal: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (pendingRenewal || controller.signal.aborted) return;
    pendingRenewal = renew().then(() => {
      if (leaseLost) controller.abort(new Error("scheduled claim lease lost"));
    }).finally(() => {
      pendingRenewal = null;
    });
  }, scheduledHeartbeatMs);
  try {
    return { value: await fn(() => leaseLost, controller.signal), leaseLost };
  } finally {
    clearInterval(heartbeat);
    const renewal = pendingRenewal as Promise<void> | null;
    await renewal?.catch(() => {});
  }
}

async function sweepScheduledTasks(): Promise<void> {
  if (!canClaimScheduledTasks(schedulerServiceKey)) {
    console.error("[scheduler] CLOUD_SCHEDULER_SERVICE_KEY is required; skipping scheduled tasks without claiming");
    return;
  }
  const recoveredLeases = await store.reclaimExpiredScheduledTaskLeases(100);
  if (recoveredLeases > 0) {
    console.warn(`[scheduler] recovered ${recoveredLeases} expired scheduled-task lease(s)`);
  }
  const due = await store.claimDueScheduledTasks(20, scheduledLeaseMs);
  const brainBase = process.env.CLOUD_BRAIN_URL || `http://127.0.0.1:${cloud.server.port}`;
  for (const task of due) {
    const startedAt = Date.now();
    try {
      const execution = await withScheduledClaimHeartbeat(task, async (isLeaseLost, signal) => {
        if (task.task_kind === "internal") {
        const res = await fetch(`${brainBase.replace(/\/$/, "")}/internal/scheduled-tasks/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Piclaw-Service-Key": schedulerServiceKey,
          },
          body: JSON.stringify(task),
          signal,
        });
        const body = await res.json().catch(() => ({})) as { ok?: boolean; summary?: string; error?: string };
        if (isLeaseLost()) {
          return;
        }
        if (res.ok && body.ok) {
          const nextRun = task.schedule_type === "once"
            ? null
            : computeNextRun(task.schedule_type, task.schedule_value, { currentDate: new Date() });
          const completed = await store.completeScheduledTaskClaim(
            task.id,
            task.claim_token,
            nextRun,
            body.summary ?? "ok",
          );
          if (completed) {
            console.log(`[scheduler] ran internal task ${task.id}: ${body.summary ?? "ok"}`);
          } else {
            console.warn(`[scheduler] ignored stale internal completion for ${task.id}`);
          }
        } else {
          const errorText = body.error ?? `HTTP ${res.status}`;
          const failed = await store.failScheduledTaskClaim(task.id, task.claim_token, errorText);
          console.warn(
            `[scheduler] internal task ${task.id} failed: ${errorText}`
              + (failed.updated && failed.retryDelayMs != null ? `; retry in ${failed.retryDelayMs}ms` : ""),
          );
        }
          return;
        }

      const res = await fetch(`${brainBase.replace(/\/$/, "")}/internal/scheduled-tasks/subagent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Piclaw-Service-Key": schedulerServiceKey,
        },
        body: JSON.stringify(task),
        signal,
      });
      const durationMs = Date.now() - startedAt;
      if (isLeaseLost()) {
        return;
      }
      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { success?: boolean; data?: { run_id?: string } };
        const resultSummary = body.data?.run_id ? `spawned subagent ${body.data.run_id}` : "spawned subagent";
        await store.appendTaskRunLog({
          taskId: task.id,
          durationMs,
          status: "success",
          result: resultSummary,
        });
        const nextRun = task.schedule_type === "once"
          ? null
          : computeNextRun(task.schedule_type, task.schedule_value, { currentDate: new Date() });
        const completed = await store.completeScheduledTaskClaim(task.id, task.claim_token, nextRun, resultSummary);
        if (completed) {
          console.log(`[scheduler] spawned scheduled subagent for ${task.session_id} (${task.id})`);
        } else {
          console.warn(`[scheduler] ignored stale completion for ${task.id}`);
        }
      } else {
        const errorText = `HTTP ${res.status}`;
        await store.appendTaskRunLog({
          taskId: task.id,
          durationMs,
          status: "error",
          error: errorText,
        });
        const failed = await store.failScheduledTaskClaim(task.id, task.claim_token, errorText);
        console.warn(
          `[scheduler] failed to spawn ${task.id}: ${errorText}`
            + (failed.updated && failed.retryDelayMs != null ? `; retry in ${failed.retryDelayMs}ms` : ""),
        );
      }
      });
      if (execution.leaseLost) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "scheduler_claim_lease_lost",
          taskId: task.id,
          claimToken: task.claim_token,
          manualRecoveryRequired: true,
        }));
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await store.appendTaskRunLog({
        taskId: task.id,
        durationMs,
        status: "error",
        error: message,
      });
      const failed = await store.failScheduledTaskClaim(task.id, task.claim_token, message);
      console.warn(`[scheduler] scheduled task ${task.id} failed:`, error);
      if (failed.updated && failed.retryDelayMs != null) {
        console.warn(`[scheduler] retrying ${task.id} in ${failed.retryDelayMs}ms`);
      }
    }
  }
}

await applyMigrations();
console.log(JSON.stringify({
  level: "info",
  event: "scheduler_started",
  idleMs,
  pollMs,
  scheduledLeaseMs,
  scheduledHeartbeatMs,
  idlePauseLeaseMs,
}));
let stopping = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let currentSweep: Promise<void> | null = null;
const runSweep = async () => {
  if (stopping || currentSweep) return;
  const startedAt = Date.now();
  currentSweep = (async () => {
  try {
    await sweepIdleSandboxes();
    await sweepScheduledTasks();
  } catch (error) {
    console.error("[scheduler] sweep failed:", error);
  } finally {
    console.log(JSON.stringify({
      level: "info",
      event: "scheduler_sweep_finished",
      durationMs: Date.now() - startedAt,
    }));
  }
  })();
  try {
    await currentSweep;
  } finally {
    currentSweep = null;
    if (!stopping) timer = setTimeout(() => void runSweep(), pollMs);
  }
};
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  await currentSweep;
  console.log(JSON.stringify({
    level: "info",
    event: "scheduler_stopped",
    signal,
  }));
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
void runSweep();
