import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { counted, sql, type RoundtripCounter } from "./db.ts";
import { LOCK_NAMESPACE } from "./config.ts";

export * from "./auth.ts";
export * from "./quota.ts";
export * from "./rls.ts";
export * from "./scheduler.ts";
export * from "./scheduled-tasks.ts";
export * from "./media.ts";
export * from "./web-push.ts";
export * from "./session-recordings.ts";
export * from "./model-preferences.ts";
export type { UserPreferences, SessionModelPrefs } from "./model-preferences.ts";
export { computeNextRun } from "./compute-next-run.ts";
export type { ComputeNextRunOptions } from "./compute-next-run.ts";
export * from "./subagent-runs.ts";
export * from "./session-capabilities.ts";
export * from "./skills.ts";
export type { SessionMode, TodoItem, TodoState } from "./session-capabilities.ts";
export type { SkillScope, SkillSource, SkillRow, SkillPublicRow, SkillCatalogRow } from "./skills.ts";

export interface MessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  content_blocks: unknown | null;
  recovery_marker: boolean;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  sandbox_id: string | null;
  workspace_volume_id: string | null;
  archived_at: string | null;
}

export interface ListSessionsOptions {
  includeArchived?: boolean;
}

/** Default title for newly created sessions before async title generation. */
export const UNTITLED_SESSION_TITLE = "New chat";

export function isTemporarySessionTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === UNTITLED_SESSION_TITLE || trimmed === "Chat";
}

// ── sessions ──────────────────────────────────────────────────────────

export async function createSession(
  id: string,
  title: string,
  userId = DEFAULT_USER_ID,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO sessions (id, user_id, title)
      VALUES (${id}, ${userId}, ${title})
      ON CONFLICT (id) DO NOTHING`;
    await tx`
      INSERT INTO session_cursors (session_id) VALUES (${id})
      ON CONFLICT DO NOTHING`;
  });
}

export async function listSessions(
  userId = DEFAULT_USER_ID,
  options: ListSessionsOptions = {},
): Promise<SessionRow[]> {
  const includeArchived = Boolean(options.includeArchived);
  const rows = includeArchived
    ? await sql`
        SELECT id, user_id, title, sandbox_id, workspace_volume_id, archived_at
        FROM sessions WHERE user_id = ${userId}
        ORDER BY updated_at DESC`
    : await sql`
        SELECT id, user_id, title, sandbox_id, workspace_volume_id, archived_at
        FROM sessions WHERE user_id = ${userId} AND archived_at IS NULL
        ORDER BY updated_at DESC`;
  return rows as SessionRow[];
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const rows = await sql`
    SELECT id, user_id, title, sandbox_id, workspace_volume_id, archived_at FROM sessions WHERE id = ${id}`;
  return (rows[0] as SessionRow) ?? null;
}

export async function getSessionForUser(id: string, userId: string): Promise<SessionRow | null> {
  const rows = await sql`
    SELECT id, user_id, title, sandbox_id, workspace_volume_id, archived_at FROM sessions
    WHERE id = ${id} AND user_id = ${userId}`;
  return (rows[0] as SessionRow) ?? null;
}

export async function archiveSession(id: string, userId = DEFAULT_USER_ID): Promise<SessionRow> {
  const existing = await getSessionForUser(id, userId);
  if (!existing) throw new Error(`Unknown chat branch: ${id}`);
  if (existing.archived_at) return existing;

  const rows = await sql`
    UPDATE sessions
    SET archived_at = now(), updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, user_id, title, sandbox_id, workspace_volume_id, archived_at`;
  return rows[0] as SessionRow;
}

export async function restoreSession(
  id: string,
  userId = DEFAULT_USER_ID,
  title?: string,
): Promise<SessionRow> {
  const existing = await getSessionForUser(id, userId);
  if (!existing) throw new Error(`Unknown chat branch: ${id}`);

  const nextTitle = typeof title === "string" && title.trim() ? title.trim() : null;
  const rows = await sql`
    UPDATE sessions
    SET archived_at = NULL,
        title = COALESCE(${nextTitle}, title),
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, user_id, title, sandbox_id, workspace_volume_id, archived_at`;
  return rows[0] as SessionRow;
}

export async function renameSessionTitle(
  id: string,
  title: string,
  userId = DEFAULT_USER_ID,
): Promise<SessionRow> {
  const existing = await getSessionForUser(id, userId);
  if (!existing) throw new Error(`Unknown chat branch: ${id}`);

  const nextTitle = title.trim();
  if (!nextTitle) throw new Error("agent_name is required");

  const rows = await sql`
    UPDATE sessions
    SET title = ${nextTitle}, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, user_id, title, sandbox_id, workspace_volume_id, archived_at`;
  return rows[0] as SessionRow;
}

/** Update title only while it is still the placeholder value (manual renames are preserved). */
export async function renameSessionTitleIfTemporary(
  id: string,
  title: string,
  userId = DEFAULT_USER_ID,
): Promise<SessionRow | null> {
  const existing = await getSessionForUser(id, userId);
  if (!existing || !isTemporarySessionTitle(existing.title)) return null;

  const nextTitle = title.trim();
  if (!nextTitle || isTemporarySessionTitle(nextTitle)) return null;

  const rows = await sql`
    UPDATE sessions
    SET title = ${nextTitle}, updated_at = now()
    WHERE id = ${id}
      AND user_id = ${userId}
      AND title IN (${UNTITLED_SESSION_TITLE}, 'Chat')
    RETURNING id, user_id, title, sandbox_id, workspace_volume_id, archived_at`;
  return (rows[0] as SessionRow) ?? null;
}

export async function countUserMessages(sessionId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS count
    FROM messages
    WHERE session_id = ${sessionId} AND role = 'user'`;
  return Number(rows[0]?.count ?? 0);
}

export async function purgeSession(
  id: string,
  userId = DEFAULT_USER_ID,
): Promise<SessionRow> {
  const existing = await getSessionForUser(id, userId);
  if (!existing) throw new Error(`Unknown chat branch: ${id}`);
  if (!existing.archived_at) {
    throw new Error(`Cannot permanently delete a branch that is not archived: ${id}`);
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM session_cursors WHERE session_id = ${id}`;
    await tx`
      DELETE FROM sessions
      WHERE id = ${id} AND user_id = ${userId} AND archived_at IS NOT NULL`;
  });
  return existing;
}

export async function setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_id = ${sandboxId}, sandbox_paused_at = NULL, updated_at = now()
    WHERE id = ${sessionId}`;
}

export async function setWorkspaceVolumeId(sessionId: string, volumeId: string): Promise<void> {
  await sql`
    UPDATE sessions SET workspace_volume_id = ${volumeId}, updated_at = now()
    WHERE id = ${sessionId}`;
}

export async function clearSandboxId(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions SET sandbox_id = NULL, sandbox_paused_at = NULL, updated_at = now()
    WHERE id = ${sessionId}`;
}

// ── messages ──────────────────────────────────────────────────────────

export async function insertMessage(
  sessionId: string,
  role: MessageRow["role"],
  content: string,
  options: {
    recoveryMarker?: boolean;
    counter?: RoundtripCounter;
    contentBlocks?: unknown | null;
  } = {},
): Promise<number> {
  const rows = await counted(options.counter)`
    INSERT INTO messages (session_id, role, content, content_blocks, recovery_marker)
    VALUES (
      ${sessionId}, ${role}, ${content},
      ${options.contentBlocks ?? null},
      ${options.recoveryMarker ?? false}
    )
    RETURNING id`;
  return Number(rows[0].id);
}

export async function listMessages(sessionId: string, limit = 50): Promise<MessageRow[]> {
  const rows = await sql`
    SELECT * FROM (
      SELECT id, session_id, role, content, content_blocks, recovery_marker, created_at
      FROM messages WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${limit}
    ) sub ORDER BY id ASC`;
  return rows as MessageRow[];
}

export async function hydrate(
  sessionId: string,
  counter: RoundtripCounter,
  limit = 50,
): Promise<MessageRow[]> {
  const rows = await counted(counter)`
    SELECT * FROM (
      SELECT id, session_id, role, content, content_blocks, recovery_marker, created_at
      FROM messages WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${limit}
    ) sub ORDER BY id ASC`;
  return rows as MessageRow[];
}

// ── advisory lock ─────────────────────────────────────────────────────

export interface SessionLock {
  release: () => Promise<void>;
}

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

export async function isSessionLocked(sessionId: string): Promise<boolean> {
  const rows = await sql`
    SELECT count(*) > 0 AS held FROM pg_locks
    WHERE locktype = 'advisory' AND classid = ${LOCK_NAMESPACE}
      AND objid = hashtext(${sessionId})::oid AND granted`;
  return Boolean(rows[0]?.held);
}

// ── turn state machine ────────────────────────────────────────────────

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

export async function getStaleInflight(graceMs: number): Promise<InflightRow[]> {
  const rows = await sql`
    SELECT session_id, inflight_message_id, inflight_started_at
    FROM session_cursors
    WHERE inflight_message_id IS NOT NULL
      AND inflight_started_at < now() - make_interval(secs => ${graceMs / 1000})`;
  return rows as InflightRow[];
}

export async function hasAssistantReplyAfter(sessionId: string, messageId: number): Promise<boolean> {
  const rows = await sql`
    SELECT count(*) > 0 AS done FROM messages
    WHERE session_id = ${sessionId} AND role = 'assistant' AND id > ${messageId}
      AND (
        content_blocks IS NULL
        OR NOT (content_blocks ? 'tool_calls')
      )`;
  return Boolean(rows[0]?.done);
}

// ── follow-up queue ───────────────────────────────────────────────────

export interface QueuedFollowup {
  content: string;
  messageId: number;
}

export async function enqueueFollowup(
  sessionId: string,
  item: QueuedFollowup,
  counter?: RoundtripCounter,
): Promise<void> {
  await counted(counter)`
    UPDATE session_cursors
    SET queued_followups = queued_followups
      || jsonb_build_array(jsonb_build_object('content', ${item.content}::text, 'message_id', ${item.messageId}::bigint))
    WHERE session_id = ${sessionId}`;
}

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
  const items = await listQueuedFollowupItems(sessionId);
  return items.map((item) => item.content);
}

export async function listQueuedFollowupItems(sessionId: string): Promise<QueuedFollowup[]> {
  const rows = await sql`
    SELECT queued_followups FROM session_cursors WHERE session_id = ${sessionId}`;
  const arr = rows[0]?.queued_followups ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => ({
    content: String((item as { content?: unknown }).content ?? ""),
    messageId: Number((item as { message_id?: unknown }).message_id),
  }));
}

export async function removeFollowupByMessageId(
  sessionId: string,
  messageId: number,
  counter?: RoundtripCounter,
): Promise<QueuedFollowup | null> {
  const rows = await counted(counter)`
    WITH cur AS (
      SELECT queued_followups FROM session_cursors WHERE session_id = ${sessionId} FOR UPDATE
    ),
    found AS (
      SELECT
        ord - 1 AS idx,
        elem->>'content' AS content,
        (elem->>'message_id')::bigint AS message_id
      FROM cur,
      jsonb_array_elements(cur.queued_followups) WITH ORDINALITY AS t(elem, ord)
      WHERE (elem->>'message_id')::bigint = ${messageId}
      LIMIT 1
    )
    UPDATE session_cursors sc
    SET queued_followups = sc.queued_followups - found.idx::int
    FROM found
    WHERE sc.session_id = ${sessionId}
    RETURNING found.content, found.message_id`;
  const row = rows[0];
  if (!row || row.content == null) return null;
  return { content: String(row.content), messageId: Number(row.message_id) };
}

export async function reorderFollowups(
  sessionId: string,
  fromIndex: number,
  toIndex: number,
  counter?: RoundtripCounter,
): Promise<boolean> {
  const rows = await counted(counter)`
    SELECT queued_followups FROM session_cursors WHERE session_id = ${sessionId} FOR UPDATE`;
  const raw = rows[0]?.queued_followups;
  if (!Array.isArray(raw)) return false;
  const items = raw.map((item) => ({
    content: String((item as { content?: unknown }).content ?? ""),
    message_id: Number((item as { message_id?: unknown }).message_id),
  }));
  if (
    fromIndex < 0 || toIndex < 0
    || fromIndex >= items.length || toIndex >= items.length
    || fromIndex === toIndex
  ) {
    return false;
  }
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved!);
  await counted(counter)`
    UPDATE session_cursors
    SET queued_followups = ${JSON.stringify(items)}::jsonb
    WHERE session_id = ${sessionId}`;
  return true;
}

export async function deleteMessage(
  sessionId: string,
  messageId: number,
  counter?: RoundtripCounter,
): Promise<boolean> {
  const rows = await counted(counter)`
    DELETE FROM messages WHERE session_id = ${sessionId} AND id = ${messageId} RETURNING id`;
  return rows.length > 0;
}

export async function getCursor(sessionId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql`SELECT * FROM session_cursors WHERE session_id = ${sessionId}`;
  return rows[0] ?? null;
}

// ── token usage ───────────────────────────────────────────────────────

export async function logTokenUsage(row: {
  sessionId: string;
  messageId?: number;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}): Promise<void> {
  await sql`
    INSERT INTO token_usage (
      session_id, message_id, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms
    ) VALUES (
      ${row.sessionId}, ${row.messageId ?? null}, ${row.model ?? null}, ${row.provider ?? null},
      ${row.inputTokens}, ${row.outputTokens},
      ${row.cacheReadTokens ?? 0}, ${row.cacheWriteTokens ?? 0}, ${row.durationMs ?? null}
    )`;
}
