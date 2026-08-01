import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import { createSession } from "./index.ts";
import {
  beginScheduledTaskExecution,
  claimIdleSessionsForPause,
  claimDueScheduledTasks,
  completeIdleSessionPauseClaim,
  completeScheduledTaskClaim,
  failScheduledTaskClaim,
  resetScheduledTaskExecutionForRetry,
  failIdleSessionPauseClaim,
  getScheduledTaskRetryDelayMs,
  reclaimExpiredScheduledTaskLeases,
  renewScheduledTaskClaim,
  renewIdleSessionPauseClaim,
  validateIdleSessionPauseClaim,
  upsertScheduledTask,
} from "./index.ts";

const TEST_SESSION = `web:scheduler-lease-${Date.now()}`;
const TEST_TASK_PREFIX = `${TEST_SESSION}-task`;
let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    await createSession(TEST_SESSION, "Scheduler lease test");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await sql`DELETE FROM scheduled_tasks WHERE id LIKE ${`${TEST_TASK_PREFIX}%`}`;
  await sql`DELETE FROM sessions WHERE id = ${TEST_SESSION}`;
});

async function createDueTask(suffix: string): Promise<string> {
  const id = `${TEST_TASK_PREFIX}-${suffix}`;
  await upsertScheduledTask({
    id,
    sessionId: TEST_SESSION,
    prompt: "lease test",
    scheduleType: "once",
    scheduleValue: "",
    nextRun: new Date(Date.now() - 1_000).toISOString(),
  });
  return id;
}

describe("scheduled task leases", () => {
  it("atomically leases due work and does not issue a second live lease", async () => {
    if (!pgAvailable) return;
    const id = await createDueTask("exclusive");

    const first = await claimDueScheduledTasks(20, 60_000);
    const claimed = first.find((task) => task.id === id);
    expect(claimed?.claim_token).toBeString();

    const second = await claimDueScheduledTasks(20, 60_000);
    expect(second.some((task) => task.id === id)).toBe(false);
  });

  it("allows only one concurrent execution starter for the same claim token", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: scheduler execution test requires a database");
    const id = await createDueTask("execution-exclusive");
    const claim = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");

    const starts = await Promise.all([
      beginScheduledTaskExecution(id, claim.claim_token),
      beginScheduledTaskExecution(id, claim.claim_token),
    ]);

    expect(starts.filter(Boolean)).toHaveLength(1);
  });

  it("reclaims an expired lease with a new claim token", async () => {
    if (!pgAvailable) return;
    const id = await createDueTask("reclaim");
    const first = (await claimDueScheduledTasks(20, 1)).find((task) => task.id === id);
    expect(first?.claim_token).toBeString();

    await Bun.sleep(5);
    const reclaimed = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    expect(reclaimed?.claim_token).toBeString();
    expect(reclaimed?.claim_token).not.toBe(first?.claim_token);
    expect(reclaimed?.attempt_count).toBe(2);
  });

  it("rejects stale completion and applies finite retry backoff to the owning claim", async () => {
    if (!pgAvailable) return;
    const id = await createDueTask("ownership");
    const first = (await claimDueScheduledTasks(20, 1)).find((task) => task.id === id);
    if (!first) throw new Error("test task was not claimed");

    await Bun.sleep(5);
    const current = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    if (!current) throw new Error("test task was not reclaimed");

    expect(await completeScheduledTaskClaim(id, first.claim_token, null, "stale")).toBe(false);
    const failed = await failScheduledTaskClaim(id, current.claim_token, "temporary failure");
    expect(failed).toEqual({
      updated: true,
      retryDelayMs: getScheduledTaskRetryDelayMs(2),
      status: "active",
    });
  });

  it("renews only the live claim token and rejects finalize after lease loss", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: scheduler heartbeat test requires a database");
    const id = await createDueTask("heartbeat");
    const claim = (await claimDueScheduledTasks(20, 5_000)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");

    expect(await renewScheduledTaskClaim(id, "stale-token", 60_000)).toBe(false);
    expect(await renewScheduledTaskClaim(id, claim.claim_token, 60_000)).toBe(true);
    expect(await completeScheduledTaskClaim(id, claim.claim_token, null, "renewed")).toBe(true);

    const expiredId = await createDueTask("heartbeat-lost");
    const expired = (await claimDueScheduledTasks(20, 1)).find((task) => task.id === expiredId);
    if (!expired) throw new Error("expiring task was not claimed");
    await Bun.sleep(5);

    expect(await completeScheduledTaskClaim(expiredId, expired.claim_token, null, "stale")).toBe(false);
    expect(await failScheduledTaskClaim(expiredId, expired.claim_token, "stale failure")).toEqual({
      updated: false,
      retryDelayMs: null,
      status: "active",
    });
  });

  it("pauses a task after the defined third failed attempt", async () => {
    if (!pgAvailable) return;
    const id = await createDueTask("retry-limit");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
      if (!claim) throw new Error(`test task was not claimed on attempt ${attempt}`);
      const failed = await failScheduledTaskClaim(id, claim.claim_token, `failure ${attempt}`);
      expect(failed.status).toBe(attempt === 3 ? "paused" : "active");
      if (attempt < 3) {
        await sql`UPDATE scheduled_tasks SET next_run = now() - interval '1 second' WHERE id = ${id}`;
      }
    }
  });

  it("sweep recovers an expired lease for a retry", async () => {
    if (!pgAvailable) return;
    const id = await createDueTask("sweep");
    const claim = (await claimDueScheduledTasks(20, 20)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");

    await Bun.sleep(25);
    expect(await reclaimExpiredScheduledTaskLeases()).toBeGreaterThanOrEqual(1);
    const recovered = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    expect(recovered?.claim_token).toBeString();
    expect(recovered?.attempt_count).toBe(2);
  });

  it("fail-closes an expired lease after side effects may have started", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: scheduler crash recovery test requires a database");
    const id = await createDueTask("execution-crash");
    const claim = (await claimDueScheduledTasks(20, 20)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");
    expect(await beginScheduledTaskExecution(id, claim.claim_token)).toBe(true);

    await Bun.sleep(25);
    expect(await reclaimExpiredScheduledTaskLeases()).toBeGreaterThanOrEqual(1);
    const rows = await sql`
      SELECT status, claim_token, execution_started_at, last_error
      FROM scheduled_tasks WHERE id = ${id}`;
    expect(rows[0]?.status).toBe("paused");
    expect(rows[0]?.claim_token).toBeNull();
    expect(rows[0]?.execution_started_at).not.toBeNull();
    expect(String(rows[0]?.last_error)).toContain("manual recovery");
    expect((await claimDueScheduledTasks(20, 60_000)).some((task) => task.id === id)).toBe(false);
  });

  it("pauses instead of retrying when an executing claim reports failure", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: scheduler execution failure test requires a database");
    const id = await createDueTask("execution-failed");
    const claim = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");
    expect(await beginScheduledTaskExecution(id, claim.claim_token)).toBe(true);

    const failed = await failScheduledTaskClaim(id, claim.claim_token, "remote execution failed");
    expect(failed).toEqual({ updated: true, retryDelayMs: null, status: "paused" });
    const rows = await sql`
      SELECT status, execution_started_at, last_error
      FROM scheduled_tasks WHERE id = ${id}`;
    expect(rows[0]?.status).toBe("paused");
    expect(rows[0]?.execution_started_at).not.toBeNull();
    expect(String(rows[0]?.last_error)).toContain("manual recovery");
  });

  it("retries capacity rejection after fenced execution reset", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: scheduler capacity retry test requires a database");
    const id = await createDueTask("capacity-retry");
    const claim = (await claimDueScheduledTasks(20, 60_000)).find((task) => task.id === id);
    if (!claim) throw new Error("test task was not claimed");
    expect(await beginScheduledTaskExecution(id, claim.claim_token)).toBe(true);

    expect(await resetScheduledTaskExecutionForRetry(id, claim.claim_token)).toBe(true);
    const failed = await failScheduledTaskClaim(id, claim.claim_token, "subagent capacity unavailable");

    expect(failed.updated).toBe(true);
    expect(failed.status).toBe("active");
    expect(failed.retryDelayMs).toBeNumber();
  });
});

describe("idle sandbox pause leases", () => {
  it("leases an idle sandbox once and fences stale completion", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: idle pause lease test requires a database");
    await sql`
      UPDATE sessions
      SET sandbox_id = 'sandbox-lease-test',
          sandbox_paused_at = NULL,
          last_active_at = now() - interval '1 hour'
      WHERE id = ${TEST_SESSION}`;

    const first = await claimIdleSessionsForPause(1_000, 10, 60_000);
    const claim = first.find((row) => row.id === TEST_SESSION);
    expect(claim?.pause_claim_token).toBeString();
    expect((await claimIdleSessionsForPause(1_000, 10, 60_000)).some((row) => row.id === TEST_SESSION)).toBe(false);

    expect(await completeIdleSessionPauseClaim(TEST_SESSION, "stale-token")).toBe(false);
    expect(await completeIdleSessionPauseClaim(TEST_SESSION, claim!.pause_claim_token)).toBe(true);
  });

  it("releases a failed idle pause claim for a safe retry", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: idle pause release test requires a database");
    await sql`
      UPDATE sessions
      SET sandbox_id = 'sandbox-pause-retry',
          sandbox_paused_at = NULL,
          last_active_at = now() - interval '1 hour',
          pause_claim_token = NULL,
          pause_claim_expires_at = NULL
      WHERE id = ${TEST_SESSION}`;

    const claim = (await claimIdleSessionsForPause(1_000, 10, 60_000)).find((row) => row.id === TEST_SESSION);
    if (!claim) throw new Error("idle session was not claimed");
    expect(await failIdleSessionPauseClaim(TEST_SESSION, claim.pause_claim_token)).toBe(true);
    expect((await claimIdleSessionsForPause(1_000, 10, 60_000)).some((row) => row.id === TEST_SESSION)).toBe(true);
  });

  it("renews and validates only an idle live pause claim", async () => {
    if (!pgAvailable) throw new Error("PostgreSQL unavailable: idle pause heartbeat test requires a database");
    await sql`
      UPDATE sessions
      SET sandbox_id = 'sandbox-pause-heartbeat',
          sandbox_paused_at = NULL,
          last_active_at = now() - interval '1 hour',
          pause_claim_token = NULL,
          pause_claim_expires_at = NULL
      WHERE id = ${TEST_SESSION}`;
    const claim = (await claimIdleSessionsForPause(1_000, 10, 5_000)).find((row) => row.id === TEST_SESSION);
    if (!claim) throw new Error("idle session was not claimed");

    expect(await renewIdleSessionPauseClaim(TEST_SESSION, claim.pause_claim_token, 60_000, 1_000)).toBe(true);
    expect(await validateIdleSessionPauseClaim(TEST_SESSION, claim.pause_claim_token, 1_000)).toBe(true);
    await sql`UPDATE sessions SET last_active_at = now() WHERE id = ${TEST_SESSION}`;
    expect(await validateIdleSessionPauseClaim(TEST_SESSION, claim.pause_claim_token, 1_000)).toBe(false);
    expect(await renewIdleSessionPauseClaim(TEST_SESSION, claim.pause_claim_token, 60_000, 1_000)).toBe(false);
  });
});
