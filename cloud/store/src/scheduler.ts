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
