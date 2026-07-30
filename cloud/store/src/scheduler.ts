import { sql } from "./db.ts";

export interface IdleSessionRow {
  id: string;
  sandbox_id: string;
  last_active_at: string;
}

export async function touchSessionActivity(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET last_active_at = now(), updated_at = now(), sandbox_paused_at = NULL
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

export async function markSandboxPaused(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_paused_at = now(), updated_at = now()
    WHERE id = ${sessionId}`;
}

export async function clearSandboxPaused(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_paused_at = NULL, last_active_at = now(), updated_at = now()
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
      status = 'active'`;
}

export async function listDueScheduledTasks(limit = 20): Promise<
  Array<{ id: string; session_id: string; prompt: string; schedule_type: string; schedule_value: string }>
> {
  const rows = await sql`
    SELECT id, session_id, prompt, schedule_type, schedule_value
    FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= now()
    ORDER BY next_run ASC
    LIMIT ${limit}`;
  return rows as Array<{ id: string; session_id: string; prompt: string; schedule_type: string; schedule_value: string }>;
}
