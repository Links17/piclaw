import { sql } from "./db.ts";

export type AutoresearchStatus = "running" | "stopped" | "completed" | "failed";

export interface AutoresearchRunRow {
  id: string;
  session_id: string;
  execution_session_id: string;
  prompt: string;
  status: AutoresearchStatus;
  started_at: string;
  finished_at: string | null;
  dismissed_at: string | null;
  stop_requested_at: string | null;
  summary: string | null;
  error: string | null;
}

function mapRun(row: Record<string, unknown>): AutoresearchRunRow {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    execution_session_id: String(row.execution_session_id),
    prompt: String(row.prompt),
    status: String(row.status) as AutoresearchStatus,
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    dismissed_at: row.dismissed_at == null ? null : String(row.dismissed_at),
    stop_requested_at: row.stop_requested_at == null ? null : String(row.stop_requested_at),
    summary: row.summary == null ? null : String(row.summary),
    error: row.error == null ? null : String(row.error),
  };
}

export async function getAutoresearchRunForSession(sessionId: string): Promise<AutoresearchRunRow | null> {
  const rows = await sql`
    SELECT *
    FROM autoresearch_runs
    WHERE session_id = ${sessionId}
      AND dismissed_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1`;
  return rows[0] ? mapRun(rows[0] as Record<string, unknown>) : null;
}

export async function createAutoresearchRun(row: {
  id: string;
  sessionId: string;
  executionSessionId: string;
  prompt: string;
  status: AutoresearchStatus;
  startedAt: string;
}): Promise<void> {
  await sql`
    INSERT INTO autoresearch_runs (
      id, session_id, execution_session_id, prompt, status, started_at
    ) VALUES (
      ${row.id}, ${row.sessionId}, ${row.executionSessionId}, ${row.prompt}, ${row.status}, ${row.startedAt}
    )`;
}

export async function updateAutoresearchRun(
  id: string,
  updates: {
    status?: AutoresearchStatus;
    finishedAt?: string | null;
    dismissedAt?: string | null;
    stopRequestedAt?: string | null;
    summary?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE autoresearch_runs
    SET status = COALESCE(${updates.status ?? null}, status),
        finished_at = CASE WHEN ${updates.finishedAt === undefined} THEN finished_at ELSE ${updates.finishedAt ?? null} END,
        dismissed_at = CASE WHEN ${updates.dismissedAt === undefined} THEN dismissed_at ELSE ${updates.dismissedAt ?? null} END,
        stop_requested_at = CASE WHEN ${updates.stopRequestedAt === undefined} THEN stop_requested_at ELSE ${updates.stopRequestedAt ?? null} END,
        summary = CASE WHEN ${updates.summary === undefined} THEN summary ELSE ${updates.summary ?? null} END,
        error = CASE WHEN ${updates.error === undefined} THEN error ELSE ${updates.error ?? null} END
    WHERE id = ${id}`;
}
