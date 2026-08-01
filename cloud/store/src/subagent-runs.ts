import { counted, sql, type RoundtripCounter } from "./db.ts";

export type SubagentStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "stopped";

export interface SubagentRunRow {
  id: string;
  session_id: string;
  sandbox_id: string | null;
  agent_type: string;
  status: SubagentStatus;
  task: string;
  description: string | null;
  summary: string | null;
  artifacts: string[];
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  max_turns: number | null;
  background: boolean;
  tool_count: number;
  resume_parent_id: string | null;
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
  const id = String(row.id ?? "").trim();
  if (!id) {
    throw new Error("subagent run id is required");
  }
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`subagent-capacity:${row.sessionId}`}))`;
    await tx`
      INSERT INTO subagent_runs (id, session_id, sandbox_id, agent_type, status, task)
      VALUES (
        ${id},
        ${row.sessionId},
        ${row.sandboxId ?? null},
        ${row.agentType ?? "coding"},
        'pending',
        ${row.task}
      )`;
  });
}

export async function createSubagentRunIfCapacity(row: {
  id: string;
  sessionId: string;
  task: string;
  agentType?: string;
  sandboxId?: string | null;
  maxActive: number;
}): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`subagent-capacity:${row.sessionId}`}))`;
    const active = await tx`
      SELECT count(*)::int AS n FROM subagent_runs
      WHERE session_id = ${row.sessionId} AND status IN ('queued', 'running', 'pending')`;
    if (Number(active[0]?.n ?? 0) >= row.maxActive) return false;
    const inserted = await tx`
      INSERT INTO subagent_runs (id, session_id, sandbox_id, agent_type, status, task)
      VALUES (
        ${row.id}, ${row.sessionId}, ${row.sandboxId ?? null},
        ${row.agentType ?? "coding"}, 'pending', ${row.task}
      )
      RETURNING id`;
    return inserted.length > 0;
  });
}

export async function markSubagentRunning(id: string, sandboxId?: string | null): Promise<void> {
  await sql`
    UPDATE subagent_runs SET
      status = 'running',
      sandbox_id = COALESCE(${sandboxId ?? null}, sandbox_id),
      started_at = COALESCE(started_at, now()),
      finished_at = NULL,
      error = NULL
    WHERE id = ${id} AND status IN ('queued', 'running', 'pending', 'completed', 'stopped', 'failed', 'cancelled', 'timed_out')`;
}

export async function claimSubagentInvocation(input: {
  runId: string;
  sessionId: string;
  userId: string;
  invocationId: string;
  leaseMs: number;
}): Promise<{ claimed: boolean; invocationId: string; ownerToken?: string; generation?: number }> {
  return sql.begin(async (tx) => {
    const runs = await tx`
      SELECT r.id
      FROM subagent_runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ${input.runId}
        AND r.session_id = ${input.sessionId}
        AND s.user_id = ${input.userId}
      FOR UPDATE OF r`;
    if (!runs[0]) throw new Error("subagent run access denied");
    await tx`
      UPDATE subagent_invocations
      SET status = 'failed', finished_at = now()
      WHERE run_id = ${input.runId}
        AND status = 'running'
        AND lease_expires_at <= now()`;
    const ownerToken = crypto.randomUUID();
    const inserted = await tx`
      INSERT INTO subagent_invocations (id, run_id, lease_expires_at, owner_token)
      VALUES (
        ${input.invocationId},
        ${input.runId},
        now() + make_interval(secs => ${Math.max(1, input.leaseMs) / 1000}),
        ${ownerToken}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, generation`;
    return {
      claimed: Boolean(inserted[0]),
      invocationId: input.invocationId,
      ...(inserted[0] ? { ownerToken, generation: Number(inserted[0].generation) } : {}),
    };
  });
}

export async function renewSubagentInvocation(
  invocationId: string,
  ownerToken: string,
  generation: number,
  leaseMs: number,
): Promise<boolean> {
  const rows = await sql`
    UPDATE subagent_invocations
    SET lease_expires_at = now() + make_interval(secs => ${Math.max(1, leaseMs) / 1000})
    WHERE id = ${invocationId} AND status = 'running'
      AND owner_token = ${ownerToken} AND generation = ${generation}
    RETURNING 1`;
  return Boolean(rows[0]);
}

export async function finishSubagentInvocation(
  invocationId: string,
  status: "completed" | "failed" | "timed_out" | "stopped",
): Promise<void> {
  await sql`
    UPDATE subagent_invocations
    SET status = ${status}, finished_at = now()
    WHERE id = ${invocationId} AND status = 'running'`;
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
      input_tokens = input_tokens + ${outcome.inputTokens ?? 0},
      output_tokens = output_tokens + ${outcome.outputTokens ?? 0},
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

export async function getSubagentRunForUser(
  id: string,
  userId: string,
): Promise<SubagentRunRow | null> {
  const rows = await sql`
    SELECT r.*
    FROM subagent_runs r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.id = ${id} AND s.user_id = ${userId}`;
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

export async function listSubagentRunsForUser(
  sessionId: string,
  userId: string,
  limit = 20,
): Promise<SubagentRunRow[]> {
  const rows = await sql`
    SELECT r.*
    FROM subagent_runs r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.session_id = ${sessionId} AND s.user_id = ${userId}
    ORDER BY r.created_at DESC
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

export async function countActiveSubagents(sessionId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM subagent_runs
    WHERE session_id = ${sessionId} AND status IN ('queued', 'running', 'pending')`;
  return Number(rows[0]?.n ?? 0);
}

export async function updateSubagentRunMeta(
  id: string,
  meta: {
    description?: string | null;
    maxTurns?: number | null;
    background?: boolean;
    toolCount?: number;
    resumeParentId?: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE subagent_runs SET
      description = COALESCE(${meta.description ?? null}, description),
      max_turns = COALESCE(${meta.maxTurns ?? null}, max_turns),
      background = COALESCE(${meta.background ?? null}, background),
      tool_count = COALESCE(${meta.toolCount ?? null}, tool_count),
      resume_parent_id = COALESCE(${meta.resumeParentId ?? null}, resume_parent_id)
    WHERE id = ${id}`;
}

export async function markSubagentQueued(id: string): Promise<void> {
  await sql`UPDATE subagent_runs SET status = 'queued' WHERE id = ${id} AND status = 'pending'`;
}

export async function markSubagentStopped(id: string, summary?: string): Promise<void> {
  await sql`
    UPDATE subagent_runs SET
      status = 'stopped',
      summary = COALESCE(${summary ?? null}, summary),
      finished_at = now()
    WHERE id = ${id} AND status IN ('pending', 'queued', 'running')`;
}

export async function insertSubagentMessage(
  runId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  blocks?: { toolCallId?: string; toolName?: string },
): Promise<number> {
  const contentBlocks =
    blocks?.toolCallId || blocks?.toolName
      ? { tool_call_id: blocks.toolCallId, tool_name: blocks.toolName }
      : null;
  const rows = await sql`
    INSERT INTO subagent_messages (run_id, role, content, content_blocks)
    VALUES (${runId}, ${role}, ${content}, ${contentBlocks})
    RETURNING id`;
  return Number(rows[0]?.id ?? 0);
}

export async function listSubagentMessages(runId: string, limit = 200): Promise<
  Array<{ id: number; role: string; content: string; content_blocks: unknown; created_at: string }>
> {
  const rows = await sql`
    SELECT id, role, content, content_blocks, created_at
    FROM subagent_messages
    WHERE run_id = ${runId}
    ORDER BY id ASC
    LIMIT ${limit}`;
  return rows as Array<{ id: number; role: string; content: string; content_blocks: unknown; created_at: string }>;
}

export async function listSubagentMessagesForUser(
  runId: string,
  userId: string,
  limit = 200,
): Promise<Array<{ id: number; role: string; content: string; content_blocks: unknown; created_at: string }>> {
  const rows = await sql`
    SELECT m.id, m.role, m.content, m.content_blocks, m.created_at
    FROM subagent_messages m
    JOIN subagent_runs r ON r.id = m.run_id
    JOIN sessions s ON s.id = r.session_id
    WHERE m.run_id = ${runId} AND s.user_id = ${userId}
    ORDER BY m.id ASC
    LIMIT ${limit}`;
  return rows as Array<{ id: number; role: string; content: string; content_blocks: unknown; created_at: string }>;
}

export async function listQueuedSubagentRuns(limit = 20): Promise<SubagentRunRow[]> {
  const rows = await sql`
    SELECT * FROM subagent_runs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT ${limit}`;
  return (rows as SubagentRunRow[]).map((row) => ({
    ...row,
    artifacts: parseArtifacts(row.artifacts),
  }));
}

