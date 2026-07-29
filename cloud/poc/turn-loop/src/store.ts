/**
 * Store layer — session/message/cursor accessors.
 *
 * Ported semantics from runtime/src/db/chat-cursors.ts: every turn state
 * transition is a single SQL statement, so a crashed replica can never leave
 * a torn state. The advisory lock (session-scoped, connection-bound) replaces
 * the in-memory AgentQueue lane: it is auto-released when the holding
 * connection dies, which is exactly the crash behaviour we want.
 */
import { sql, counted, type RoundtripCounter } from "./db.ts";
import { LOCK_NAMESPACE } from "./config.ts";

export interface MessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  recovery_marker: boolean;
  created_at: string;
}

// ── sessions ──────────────────────────────────────────────────────────

export async function createSession(id: string, title: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO sessions (id, title) VALUES (${id}, ${title}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO session_cursors (session_id) VALUES (${id}) ON CONFLICT DO NOTHING`;
  });
}

export async function getSession(id: string): Promise<{ id: string; title: string } | null> {
  const rows = await sql`SELECT id, title FROM sessions WHERE id = ${id}`;
  return rows[0] ?? null;
}

// ── messages ──────────────────────────────────────────────────────────

export async function insertMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  options: { recoveryMarker?: boolean; counter?: RoundtripCounter } = {},
): Promise<number> {
  const rows = await counted(options.counter)`
    INSERT INTO messages (session_id, role, content, recovery_marker)
    VALUES (${sessionId}, ${role}, ${content}, ${options.recoveryMarker ?? false})
    RETURNING id`;
  return Number(rows[0].id);
}

export async function listMessages(sessionId: string, limit = 50): Promise<MessageRow[]> {
  const rows = await sql`
    SELECT * FROM (
      SELECT id, session_id, role, content, recovery_marker, created_at
      FROM messages WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${limit}
    ) sub ORDER BY id ASC`;
  return rows as MessageRow[];
}

/** Hydration read: recent window, oldest-first (single query). */
export async function hydrate(
  sessionId: string,
  counter: RoundtripCounter,
  limit = 50,
): Promise<MessageRow[]> {
  const rows = await counted(counter)`
    SELECT * FROM (
      SELECT id, session_id, role, content, recovery_marker, created_at
      FROM messages WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${limit}
    ) sub ORDER BY id ASC`;
  return rows as MessageRow[];
}

// ── advisory lock (per-session mutual exclusion) ──────────────────────

export interface SessionLock {
  release: () => Promise<void>;
}

/**
 * Try to take the per-session turn lock on a dedicated (reserved) connection.
 * Returns null when another replica currently runs a turn for this session.
 * The lock dies with the connection — no fencing cleanup needed on crash.
 */
export async function tryLockSession(sessionId: string): Promise<SessionLock | null> {
  const reserved = await sql.reserve();
  try {
    const rows = await reserved`
      SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}, hashtext(${sessionId})) AS locked`;
    if (!rows[0]?.locked) {
      reserved.release();
      return null;
    }
    return {
      release: async () => {
        try {
          await reserved`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, hashtext(${sessionId}))`;
        } finally {
          reserved.release();
        }
      },
    };
  } catch (error) {
    reserved.release();
    throw error;
  }
}

/** Non-reserved probe: is the turn lock currently held by anyone? */
export async function isSessionLocked(sessionId: string): Promise<boolean> {
  const rows = await sql`
    SELECT count(*) > 0 AS held FROM pg_locks
    WHERE locktype = 'advisory' AND classid = ${LOCK_NAMESPACE}
      AND objid = hashtext(${sessionId})::oid AND granted`;
  return Boolean(rows[0]?.held);
}

// ── turn state machine (single-SQL transitions) ───────────────────────

export async function beginTurn(
  sessionId: string,
  messageId: number,
  counter: RoundtripCounter,
): Promise<void> {
  await counted(counter)`
    UPDATE session_cursors SET
      inflight_prev_cursor = cursor_message_id,
      inflight_message_id = ${messageId},
      inflight_started_at = now()
    WHERE session_id = ${sessionId}`;
}

export async function endTurn(
  sessionId: string,
  messageId: number,
  counter: RoundtripCounter,
): Promise<void> {
  await counted(counter)`
    UPDATE session_cursors SET
      cursor_message_id = ${messageId},
      inflight_prev_cursor = NULL,
      inflight_message_id = NULL,
      inflight_started_at = NULL,
      failed_message_id = NULL,
      failed_at = NULL,
      failed_error = NULL
    WHERE session_id = ${sessionId}`;
}

export async function endTurnWithError(
  sessionId: string,
  messageId: number,
  error: string,
  counter: RoundtripCounter,
): Promise<void> {
  await counted(counter)`
    UPDATE session_cursors SET
      failed_message_id = ${messageId},
      failed_at = now(),
      failed_error = ${error},
      inflight_prev_cursor = NULL,
      inflight_message_id = NULL,
      inflight_started_at = NULL
    WHERE session_id = ${sessionId}`;
}

export async function clearInflight(sessionId: string): Promise<void> {
  await sql`
    UPDATE session_cursors SET
      inflight_prev_cursor = NULL,
      inflight_message_id = NULL,
      inflight_started_at = NULL
    WHERE session_id = ${sessionId}`;
}

export interface InflightRow {
  session_id: string;
  inflight_message_id: number;
  inflight_started_at: string;
}

/** Inflight rows old enough that their replica may have died. */
export async function getStaleInflight(graceMs: number): Promise<InflightRow[]> {
  const rows = await sql`
    SELECT session_id, inflight_message_id, inflight_started_at
    FROM session_cursors
    WHERE inflight_message_id IS NOT NULL
      AND inflight_started_at < now() - make_interval(secs => ${graceMs / 1000})`;
  return rows as InflightRow[];
}

/** Does a terminal assistant reply already exist after this user message? */
export async function hasAssistantReplyAfter(sessionId: string, messageId: number): Promise<boolean> {
  const rows = await sql`
    SELECT count(*) > 0 AS done FROM messages
    WHERE session_id = ${sessionId} AND role = 'assistant' AND id > ${messageId}`;
  return Boolean(rows[0]?.done);
}

// ── follow-up queue (deferred queue in session_cursors.queued_followups) ──

export interface QueuedFollowup {
  content: string;
  /** The user message row already inserted at submission time. */
  messageId: number;
}

export async function enqueueFollowup(
  sessionId: string,
  item: QueuedFollowup,
  counter?: RoundtripCounter,
): Promise<void> {
  // jsonb_build_object instead of a serialized ::jsonb parameter: Bun.sql
  // binds JSON-stringified params as jsonb *strings*, which would append a
  // string element rather than an object.
  await counted(counter)`
    UPDATE session_cursors
    SET queued_followups = queued_followups
      || jsonb_build_array(jsonb_build_object('content', ${item.content}::text, 'message_id', ${item.messageId}::bigint))
    WHERE session_id = ${sessionId}`;
}

/**
 * Atomically pop the first queued follow-up, if any. Implemented as a CTE so
 * we read the head and remove it in one statement (RETURNING reflects
 * post-update state in PG, so a plain UPDATE ... RETURNING can't do this).
 */
export async function popFollowup(
  sessionId: string,
  counter: RoundtripCounter,
): Promise<QueuedFollowup | null> {
  const rows = await counted(counter)`
    WITH head AS (
      SELECT queued_followups -> 0 ->> 'content' AS content,
             (queued_followups -> 0 ->> 'message_id')::bigint AS message_id
      FROM session_cursors
      WHERE session_id = ${sessionId} AND jsonb_array_length(queued_followups) > 0
      FOR UPDATE
    )
    UPDATE session_cursors sc
    SET queued_followups = sc.queued_followups - 0
    FROM head
    WHERE sc.session_id = ${sessionId}
    RETURNING head.content, head.message_id`;
  const row = rows[0];
  if (!row || row.content == null) return null;
  return { content: String(row.content), messageId: Number(row.message_id) };
}

export async function getQueuedFollowups(sessionId: string): Promise<string[]> {
  const rows = await sql`
    SELECT queued_followups FROM session_cursors WHERE session_id = ${sessionId}`;
  const arr = rows[0]?.queued_followups ?? [];
  return (arr as Array<{ content: string }>).map((item) => item.content);
}

export async function getCursor(sessionId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql`SELECT * FROM session_cursors WHERE session_id = ${sessionId}`;
  return rows[0] ?? null;
}

// ── usage log (for real-provider cache measurements) ──────────────────

export async function logTurnUsage(row: {
  sessionId: string;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  dbRoundtrips: number;
  durationMs: number;
}): Promise<void> {
  await sql`
    INSERT INTO turn_usage (session_id, input_tokens, cached_tokens, output_tokens, db_roundtrips, duration_ms)
    VALUES (${row.sessionId}, ${row.inputTokens}, ${row.cachedTokens}, ${row.outputTokens}, ${row.dbRoundtrips}, ${row.durationMs})`;
}
