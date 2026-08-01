import { sql } from "./db.ts";

export interface IdleSessionRow {
  id: string;
  sandbox_id: string;
  last_active_at: string;
}

export interface ClaimedIdleSessionRow extends IdleSessionRow {
  pause_claim_token: string;
}

export async function touchSessionActivity(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET last_active_at = now(), updated_at = now(), sandbox_paused_at = NULL,
      pause_claim_token = NULL, pause_claim_expires_at = NULL
    WHERE id = ${sessionId}`;
}

export async function listIdleSessions(idleMs: number, limit = 50): Promise<IdleSessionRow[]> {
  const rows = await sql`
    SELECT id, sandbox_id, last_active_at
    FROM sessions
    WHERE sandbox_id IS NOT NULL
      AND sandbox_paused_at IS NULL
      AND last_active_at < now() - make_interval(secs => ${idleMs / 1000})
    ORDER BY last_active_at ASC
    LIMIT ${limit}`;
  return rows as IdleSessionRow[];
}

export async function claimIdleSessionsForPause(
  idleMs: number,
  limit = 50,
  leaseMs = 60_000,
): Promise<ClaimedIdleSessionRow[]> {
  const rows = await sql`
    WITH claimed AS (
      SELECT id
      FROM sessions
      WHERE sandbox_id IS NOT NULL
        AND sandbox_paused_at IS NULL
        AND last_active_at < now() - make_interval(secs => ${idleMs / 1000})
        AND (pause_claim_token IS NULL OR pause_claim_expires_at <= now())
      ORDER BY last_active_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE sessions AS session
    SET pause_claim_token = md5(random()::text || clock_timestamp()::text || session.id),
        pause_claim_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    FROM claimed
    WHERE session.id = claimed.id
    RETURNING session.id, session.sandbox_id, session.last_active_at, session.pause_claim_token`;
  return rows as ClaimedIdleSessionRow[];
}

export async function completeIdleSessionPauseClaim(
  sessionId: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE sessions
    SET sandbox_paused_at = now(),
        updated_at = now(),
        pause_claim_token = NULL,
        pause_claim_expires_at = NULL
    WHERE id = ${sessionId}
      AND pause_claim_token = ${claimToken}
      AND pause_claim_expires_at > now()
    RETURNING id`;
  return rows.length > 0;
}

export async function validateIdleSessionPauseClaim(
  sessionId: string,
  claimToken: string,
  idleMs: number,
): Promise<boolean> {
  const rows = await sql`
    SELECT id
    FROM sessions
    WHERE id = ${sessionId}
      AND pause_claim_token = ${claimToken}
      AND pause_claim_expires_at > now()
      AND sandbox_paused_at IS NULL
      AND last_active_at < now() - make_interval(secs => ${idleMs / 1000})`;
  return rows.length > 0;
}

export async function renewIdleSessionPauseClaim(
  sessionId: string,
  claimToken: string,
  leaseMs: number,
  idleMs: number,
): Promise<boolean> {
  const rows = await sql`
    UPDATE sessions
    SET pause_claim_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = ${sessionId}
      AND pause_claim_token = ${claimToken}
      AND pause_claim_expires_at > now()
      AND sandbox_paused_at IS NULL
      AND last_active_at < now() - make_interval(secs => ${idleMs / 1000})
    RETURNING id`;
  return rows.length > 0;
}

export async function failIdleSessionPauseClaim(
  sessionId: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE sessions
    SET pause_claim_token = NULL,
        pause_claim_expires_at = NULL
    WHERE id = ${sessionId}
      AND pause_claim_token = ${claimToken}
    RETURNING id`;
  return rows.length > 0;
}

export async function markSandboxPaused(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_paused_at = now(), updated_at = now()
    WHERE id = ${sessionId}`;
}

export async function clearSandboxPaused(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_paused_at = NULL, last_active_at = now(), updated_at = now(),
      pause_claim_token = NULL, pause_claim_expires_at = NULL
    WHERE id = ${sessionId}`;
}

export async function createScheduledTask(row: {
  id: string;
  sessionId: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun?: Date | null;
}): Promise<void> {
  await sql`
    INSERT INTO scheduled_tasks (id, session_id, prompt, schedule_type, schedule_value, next_run, status)
    VALUES (
      ${row.id},
      ${row.sessionId},
      ${row.prompt},
      ${row.scheduleType},
      ${row.scheduleValue},
      ${row.nextRun ?? null},
      'active'
    )
    ON CONFLICT (id) DO UPDATE SET
      prompt = EXCLUDED.prompt,
      schedule_type = EXCLUDED.schedule_type,
      schedule_value = EXCLUDED.schedule_value,
      next_run = EXCLUDED.next_run,
        status = 'active',
      claimed_at = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      attempt_count = 0,
      last_error = NULL`;
}

export async function listDueScheduledTasks(limit = 20): Promise<
  Array<{
    id: string;
    session_id: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    task_kind: string;
  }>
> {
  const rows = await sql`
    SELECT id, session_id, prompt, schedule_type, schedule_value, task_kind
    FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= now()
    ORDER BY next_run ASC
    LIMIT ${limit}`;
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    session_id: String(row.session_id),
    prompt: String(row.prompt),
    schedule_type: String(row.schedule_type),
    schedule_value: String(row.schedule_value),
    task_kind: row.task_kind != null ? String(row.task_kind) : "agent",
  }));
}

export interface ClaimedScheduledTask {
  id: string;
  session_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  task_kind: string;
  claim_token: string;
  attempt_count: number;
}

const SCHEDULED_TASK_MAX_ATTEMPTS = 3;
const SCHEDULED_TASK_RETRY_DELAYS_MS = [5_000, 30_000] as const;
const SCHEDULED_TASK_RETRY_BASE_MS = SCHEDULED_TASK_RETRY_DELAYS_MS[0];

export function getScheduledTaskRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) return SCHEDULED_TASK_RETRY_BASE_MS;
  return SCHEDULED_TASK_RETRY_DELAYS_MS[1];
}

export async function claimDueScheduledTasks(
  limit = 20,
  leaseMs = 60_000,
): Promise<ClaimedScheduledTask[]> {
  const rows = await sql`
    WITH claimed AS (
      SELECT id
      FROM scheduled_tasks
      WHERE next_run IS NOT NULL
        AND next_run <= now()
        AND execution_started_at IS NULL
        AND (
          (status = 'active' AND claim_token IS NULL)
          OR (claim_token IS NOT NULL AND claim_expires_at <= now())
        )
      ORDER BY next_run ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE scheduled_tasks AS task
    SET claimed_at = now(),
        claim_token = md5(random()::text || clock_timestamp()::text || task.id),
        claim_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
        execution_started_at = NULL,
        attempt_count = task.attempt_count + 1
    FROM claimed
    WHERE task.id = claimed.id
    RETURNING task.id, task.session_id, task.prompt, task.schedule_type, task.schedule_value,
      task.task_kind, task.claim_token, task.attempt_count`;
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    session_id: String(row.session_id),
    prompt: String(row.prompt),
    schedule_type: String(row.schedule_type),
    schedule_value: String(row.schedule_value),
    task_kind: row.task_kind != null ? String(row.task_kind) : "agent",
    claim_token: String(row.claim_token),
    attempt_count: Number(row.attempt_count),
  }));
}

export async function beginScheduledTaskExecution(
  taskId: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE scheduled_tasks
    SET execution_started_at = now()
    WHERE id = ${taskId}
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()
      AND execution_started_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function resetScheduledTaskExecutionForRetry(
  taskId: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE scheduled_tasks
    SET execution_started_at = NULL
    WHERE id = ${taskId}
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()
      AND execution_started_at IS NOT NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function renewScheduledTaskClaim(
  taskId: string,
  claimToken: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await sql`
    UPDATE scheduled_tasks
    SET claim_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = ${taskId}
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()
    RETURNING id`;
  return rows.length > 0;
}

export async function completeScheduledTaskClaim(
  taskId: string,
  claimToken: string,
  nextRun: string | null,
  lastResult: string | null,
): Promise<boolean> {
  const rows = await sql`
    UPDATE scheduled_tasks
    SET last_run = now(),
        next_run = ${nextRun}::timestamptz,
        last_result = ${lastResult}::text,
        status = CASE WHEN ${nextRun}::timestamptz IS NULL THEN 'completed' ELSE 'active' END,
        claimed_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        execution_started_at = NULL,
        attempt_count = 0,
        last_error = NULL
    WHERE id = ${taskId}
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()
    RETURNING id`;
  return rows.length > 0;
}

export async function failScheduledTaskClaim(
  taskId: string,
  claimToken: string,
  error: string,
): Promise<{ updated: boolean; retryDelayMs: number | null; status: "active" | "paused" }> {
  const rows = await sql`
    UPDATE scheduled_tasks
    SET status = CASE
          WHEN execution_started_at IS NOT NULL THEN 'paused'
          WHEN attempt_count >= ${SCHEDULED_TASK_MAX_ATTEMPTS} THEN 'paused'
          ELSE 'active'
        END,
        next_run = CASE
          WHEN execution_started_at IS NOT NULL THEN next_run
          WHEN attempt_count >= ${SCHEDULED_TASK_MAX_ATTEMPTS} THEN next_run
          ELSE now() + make_interval(secs => ${
            SCHEDULED_TASK_RETRY_BASE_MS / 1000
          } * CASE WHEN attempt_count <= 1 THEN 1 ELSE 6 END)
        END,
        claimed_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        execution_started_at = execution_started_at,
        last_error = CASE
          WHEN execution_started_at IS NOT NULL
            THEN ${`${error}; side effects may have started; manual recovery required`}
          ELSE ${error}
        END
    WHERE id = ${taskId}
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()
    RETURNING attempt_count, status`;
  const row = rows[0] as { attempt_count: number; status: "active" | "paused" } | undefined;
  if (!row) return { updated: false, retryDelayMs: null, status: "active" };
  return {
    updated: true,
    retryDelayMs: row.status === "active" ? getScheduledTaskRetryDelayMs(Number(row.attempt_count)) : null,
    status: row.status,
  };
}

export async function reclaimExpiredScheduledTaskLeases(limit = 100): Promise<number> {
  const rows = await sql`
    WITH expired AS (
      SELECT id, execution_started_at
      FROM scheduled_tasks
      WHERE claim_token IS NOT NULL
        AND claim_expires_at <= now()
      ORDER BY claim_expires_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE scheduled_tasks AS task
    SET status = CASE
          WHEN expired.execution_started_at IS NOT NULL THEN 'paused'
          WHEN task.attempt_count >= ${SCHEDULED_TASK_MAX_ATTEMPTS} THEN 'paused'
          ELSE 'active'
        END,
        next_run = CASE
          WHEN expired.execution_started_at IS NOT NULL THEN task.next_run
          WHEN task.attempt_count >= ${SCHEDULED_TASK_MAX_ATTEMPTS} THEN task.next_run
          ELSE LEAST(COALESCE(task.next_run, now()), now())
        END,
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        execution_started_at = CASE
          WHEN expired.execution_started_at IS NOT NULL THEN task.execution_started_at
          ELSE NULL
        END,
        last_error = CASE
          WHEN expired.execution_started_at IS NOT NULL
            THEN COALESCE(task.last_error, 'execution lease expired after side effects may have started; manual recovery required')
          ELSE COALESCE(task.last_error, 'lease expired before execution')
        END
    FROM expired
    WHERE task.id = expired.id
    RETURNING task.id`;
  return rows.length;
}
