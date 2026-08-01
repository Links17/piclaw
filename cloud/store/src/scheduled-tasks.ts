import { sql } from "./db.ts";

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskKind = "agent" | "shell" | "internal";

export interface ScheduledTaskRow {
  id: string;
  session_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  status: ScheduledTaskStatus;
  created_at: string;
  task_kind: ScheduledTaskKind;
  model: string | null;
  notify_on_complete: boolean;
  last_result: string | null;
  summary: string | null;
  claimed_at: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
}

export interface TaskRunLogRow {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: "success" | "error";
  result: string | null;
  error: string | null;
}

function mapTask(row: Record<string, unknown>): ScheduledTaskRow {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    prompt: String(row.prompt),
    schedule_type: String(row.schedule_type),
    schedule_value: String(row.schedule_value),
    next_run: row.next_run ? String(row.next_run) : null,
    last_run: row.last_run ? String(row.last_run) : null,
    status: String(row.status) as ScheduledTaskStatus,
    created_at: String(row.created_at),
    task_kind: (row.task_kind ? String(row.task_kind) : "agent") as ScheduledTaskKind,
    model: row.model != null ? String(row.model) : null,
    notify_on_complete: row.notify_on_complete !== false,
    last_result: row.last_result != null ? String(row.last_result) : null,
    summary: row.summary != null ? String(row.summary) : null,
    claimed_at: row.claimed_at != null ? String(row.claimed_at) : null,
    claim_token: row.claim_token != null ? String(row.claim_token) : null,
    claim_expires_at: row.claim_expires_at != null ? String(row.claim_expires_at) : null,
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error != null ? String(row.last_error) : null,
  };
}

export function taskToApi(task: ScheduledTaskRow, chatJid?: string) {
  return {
    id: task.id,
    chat_jid: chatJid ?? task.session_id,
    session_id: task.session_id,
    prompt: task.prompt,
    summary: task.summary ?? task.prompt.slice(0, 80),
    model: task.model,
    task_kind: task.task_kind,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    next_run: task.next_run,
    last_run: task.last_run,
    status: task.status,
    created_at: task.created_at,
    notify_on_complete: task.notify_on_complete,
    last_result: task.last_result,
  };
}

export async function getScheduledTaskById(id: string): Promise<ScheduledTaskRow | null> {
  const rows = await sql`SELECT * FROM scheduled_tasks WHERE id = ${id}`;
  const row = rows[0];
  return row ? mapTask(row as Record<string, unknown>) : null;
}

export async function getClaimedInternalScheduledTask(
  id: string,
  claimToken: string,
): Promise<ScheduledTaskRow | null> {
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    WHERE id = ${id}
      AND task_kind = 'internal'
      AND claim_token = ${claimToken}
      AND claim_expires_at > now()`;
  const row = rows[0];
  return row ? mapTask(row as Record<string, unknown>) : null;
}

export async function getScheduledTaskByIdForUser(
  id: string,
  userId: string,
): Promise<ScheduledTaskRow | null> {
  const rows = await sql`
    SELECT t.*
    FROM scheduled_tasks t
    JOIN sessions s ON s.id = t.session_id
    WHERE t.id = ${id} AND s.user_id = ${userId}`;
  const row = rows[0];
  return row ? mapTask(row as Record<string, unknown>) : null;
}

export async function listScheduledTasks(query: {
  sessionId?: string;
  status?: ScheduledTaskStatus | null;
  limit?: number;
}): Promise<ScheduledTaskRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  if (query.sessionId && query.status) {
    const rows = await sql`
      SELECT * FROM scheduled_tasks
      WHERE session_id = ${query.sessionId} AND status = ${query.status}
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return rows.map((row: Record<string, unknown>) => mapTask(row));
  }
  if (query.sessionId) {
    const rows = await sql`
      SELECT * FROM scheduled_tasks
      WHERE session_id = ${query.sessionId}
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return rows.map((row: Record<string, unknown>) => mapTask(row));
  }
  if (query.status) {
    const rows = await sql`
      SELECT * FROM scheduled_tasks
      WHERE status = ${query.status}
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return rows.map((row: Record<string, unknown>) => mapTask(row));
  }
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows.map((row: Record<string, unknown>) => mapTask(row));
}

export async function listScheduledTasksForUser(query: {
  userId: string;
  sessionId?: string;
  status?: ScheduledTaskStatus | null;
  limit?: number;
}): Promise<ScheduledTaskRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await sql`
    SELECT t.*
    FROM scheduled_tasks t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.user_id = ${query.userId}
      AND (${query.sessionId ?? null}::text IS NULL OR t.session_id = ${query.sessionId ?? null})
      AND (${query.status ?? null}::text IS NULL OR t.status = ${query.status ?? null})
    ORDER BY t.created_at DESC
    LIMIT ${limit}`;
  return rows.map((row: Record<string, unknown>) => mapTask(row));
}

export async function updateScheduledTask(
  id: string,
  updates: Partial<Pick<ScheduledTaskRow, "prompt" | "model" | "task_kind" | "schedule_type" | "schedule_value" | "next_run" | "last_run" | "status" | "last_result" | "summary" | "notify_on_complete">>,
): Promise<void> {
  const current = await getScheduledTaskById(id);
  if (!current) return;
  await sql`
    UPDATE scheduled_tasks SET
      prompt = ${updates.prompt ?? current.prompt},
      model = ${updates.model !== undefined ? updates.model : current.model},
      task_kind = ${updates.task_kind ?? current.task_kind},
      schedule_type = ${updates.schedule_type ?? current.schedule_type},
      schedule_value = ${updates.schedule_value ?? current.schedule_value},
      next_run = ${updates.next_run !== undefined ? updates.next_run : current.next_run},
      last_run = ${updates.last_run !== undefined ? updates.last_run : current.last_run},
      status = ${updates.status ?? current.status},
      last_result = ${updates.last_result !== undefined ? updates.last_result : current.last_result},
      summary = ${updates.summary !== undefined ? updates.summary : current.summary},
      notify_on_complete = ${updates.notify_on_complete !== undefined ? updates.notify_on_complete : current.notify_on_complete},
      claimed_at = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      execution_started_at = NULL,
      attempt_count = 0,
      last_error = NULL
    WHERE id = ${id}`;
}

export async function updateScheduledTaskForUser(
  id: string,
  userId: string,
  updates: Partial<Pick<ScheduledTaskRow, "prompt" | "model" | "task_kind" | "schedule_type" | "schedule_value" | "next_run" | "last_run" | "status" | "last_result" | "summary" | "notify_on_complete">>,
): Promise<boolean> {
  const current = await getScheduledTaskByIdForUser(id, userId);
  if (!current) return false;
  const rows = await sql`
    UPDATE scheduled_tasks t SET
      prompt = ${updates.prompt ?? current.prompt},
      model = ${updates.model !== undefined ? updates.model : current.model},
      task_kind = ${updates.task_kind ?? current.task_kind},
      schedule_type = ${updates.schedule_type ?? current.schedule_type},
      schedule_value = ${updates.schedule_value ?? current.schedule_value},
      next_run = ${updates.next_run !== undefined ? updates.next_run : current.next_run},
      last_run = ${updates.last_run !== undefined ? updates.last_run : current.last_run},
      status = ${updates.status ?? current.status},
      last_result = ${updates.last_result !== undefined ? updates.last_result : current.last_result},
      summary = ${updates.summary !== undefined ? updates.summary : current.summary},
      notify_on_complete = ${updates.notify_on_complete !== undefined ? updates.notify_on_complete : current.notify_on_complete},
      claimed_at = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      execution_started_at = NULL,
      attempt_count = 0,
      last_error = NULL
    FROM sessions s
    WHERE t.id = ${id} AND s.id = t.session_id AND s.user_id = ${userId}
    RETURNING t.id`;
  return rows.length > 0;
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM scheduled_tasks WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deleteScheduledTaskForUser(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM scheduled_tasks t
    USING sessions s
    WHERE t.id = ${id} AND s.id = t.session_id AND s.user_id = ${userId}
    RETURNING t.id`;
  return rows.length > 0;
}

export async function appendTaskRunLog(row: {
  taskId: string;
  durationMs: number;
  status: "success" | "error";
  result?: string | null;
  error?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO task_run_logs (task_id, duration_ms, status, result, error)
    VALUES (${row.taskId}, ${row.durationMs}, ${row.status}, ${row.result ?? null}, ${row.error ?? null})`;
}

export async function listTaskRunLogs(taskId: string, limit = 5): Promise<TaskRunLogRow[]> {
  const rows = await sql`
    SELECT * FROM task_run_logs
    WHERE task_id = ${taskId}
    ORDER BY run_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}`;
  return rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    task_id: String(row.task_id),
    run_at: String(row.run_at),
    duration_ms: Number(row.duration_ms),
    status: String(row.status) as "success" | "error",
    result: row.result != null ? String(row.result) : null,
    error: row.error != null ? String(row.error) : null,
  }));
}

export async function listTaskRunLogsForUser(
  taskId: string,
  userId: string,
  limit = 5,
): Promise<TaskRunLogRow[]> {
  const rows = await sql`
    SELECT l.*
    FROM task_run_logs l
    JOIN scheduled_tasks t ON t.id = l.task_id
    JOIN sessions s ON s.id = t.session_id
    WHERE l.task_id = ${taskId} AND s.user_id = ${userId}
    ORDER BY l.run_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}`;
  return rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    task_id: String(row.task_id),
    run_at: String(row.run_at),
    duration_ms: Number(row.duration_ms),
    status: String(row.status) as "success" | "error",
    result: row.result != null ? String(row.result) : null,
    error: row.error != null ? String(row.error) : null,
  }));
}

export async function markScheduledTaskRan(
  taskId: string,
  nextRun: string | null,
  lastResult: string | null,
): Promise<void> {
  await sql`
    UPDATE scheduled_tasks
    SET last_run = now(),
        next_run = ${nextRun},
        last_result = ${lastResult},
        status = CASE WHEN ${nextRun} IS NULL THEN 'completed' ELSE status END
    WHERE id = ${taskId}`;
}

export async function upsertScheduledTask(row: {
  id: string;
  sessionId: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun?: string | null;
  taskKind?: ScheduledTaskKind;
  model?: string | null;
  status?: ScheduledTaskStatus;
}): Promise<void> {
  await sql`
    INSERT INTO scheduled_tasks (
      id, session_id, prompt, schedule_type, schedule_value, next_run, status, task_kind, model
    )
    VALUES (
      ${row.id},
      ${row.sessionId},
      ${row.prompt},
      ${row.scheduleType},
      ${row.scheduleValue},
      ${row.nextRun ?? null},
      ${row.status ?? "active"},
      ${row.taskKind ?? "agent"},
      ${row.model ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      prompt = EXCLUDED.prompt,
      schedule_type = EXCLUDED.schedule_type,
      schedule_value = EXCLUDED.schedule_value,
      next_run = EXCLUDED.next_run,
      status = EXCLUDED.status,
      task_kind = EXCLUDED.task_kind,
      model = EXCLUDED.model,
      claimed_at = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      execution_started_at = NULL,
      attempt_count = 0,
      last_error = NULL`;
}
