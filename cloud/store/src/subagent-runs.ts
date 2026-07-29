import { counted, sql, type RoundtripCounter } from "./db.ts";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface SubagentRunRow {
  id: string;
  session_id: string;
  sandbox_id: string | null;
  agent_type: string;
  status: SubagentStatus;
  task: string;
  summary: string | null;
  artifacts: string[];
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function parseArtifacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

export async function createSubagentRun(row: {
  id: string;
  sessionId: string;
  task: string;
  agentType?: string;
  sandboxId?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO subagent_runs (id, session_id, sandbox_id, agent_type, status, task)
    VALUES (
      ${row.id},
      ${row.sessionId},
      ${row.sandboxId ?? null},
      ${row.agentType ?? "coding"},
      'queued',
      ${row.task}
    )`;
}

export async function markSubagentRunning(id: string, sandboxId?: string | null): Promise<void> {
  await sql`
    UPDATE subagent_runs SET
      status = 'running',
      sandbox_id = COALESCE(${sandboxId ?? null}, sandbox_id),
      started_at = COALESCE(started_at, now())
    WHERE id = ${id} AND status IN ('queued', 'running')`;
}

export async function finishSubagentRun(
  id: string,
  outcome: {
    status: SubagentStatus;
    summary?: string | null;
    artifacts?: string[];
    error?: string | null;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<void> {
  await sql`
    UPDATE subagent_runs SET
      status = ${outcome.status},
      summary = ${outcome.summary ?? null},
      artifacts = ${JSON.stringify(outcome.artifacts ?? [])}::jsonb,
      error = ${outcome.error ?? null},
      input_tokens = ${outcome.inputTokens ?? 0},
      output_tokens = ${outcome.outputTokens ?? 0},
      finished_at = now()
    WHERE id = ${id}`;
}

export async function getSubagentRun(id: string): Promise<SubagentRunRow | null> {
  const rows = await sql`SELECT * FROM subagent_runs WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row as SubagentRunRow),
    artifacts: parseArtifacts(row.artifacts),
  };
}

export async function listSubagentRuns(sessionId: string, limit = 20): Promise<SubagentRunRow[]> {
  const rows = await sql`
    SELECT * FROM subagent_runs
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return (rows as SubagentRunRow[]).map((row) => ({
    ...row,
    artifacts: parseArtifacts(row.artifacts),
  }));
}

export async function countRunningSubagents(sessionId: string, counter?: RoundtripCounter): Promise<number> {
  const rows = await counted(counter)`
    SELECT count(*)::int AS n FROM subagent_runs
    WHERE session_id = ${sessionId} AND status = 'running'`;
  return Number(rows[0]?.n ?? 0);
}
