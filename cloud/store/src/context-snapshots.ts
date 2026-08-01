import { sql } from "./db.ts";

export interface SessionContextSnapshot {
  sessionId: string;
  userId: string;
  usedTokens: number;
  contextWindow: number;
  model: string;
  provider: string;
  throughMessageId: number;
  latestMessageId: number;
  compactedThroughMessageId: number;
  updatedAt: string;
}

export interface UpsertSessionContextSnapshotInput {
  sessionId: string;
  userId: string;
  usedTokens: number;
  contextWindow: number;
  model: string;
  provider: string;
  throughMessageId: number;
  latestMessageId: number;
  compactedThroughMessageId: number;
}

function snapshotRow(row: Record<string, unknown>): SessionContextSnapshot {
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    usedTokens: Number(row.used_tokens),
    contextWindow: Number(row.context_window),
    model: String(row.model),
    provider: String(row.provider),
    throughMessageId: Number(row.through_message_id),
    latestMessageId: Number(row.latest_message_id),
    compactedThroughMessageId: Number(row.compacted_through_message_id),
    updatedAt: String(row.updated_at),
  };
}

export async function getSessionContextSnapshotForUser(
  sessionId: string,
  userId: string,
): Promise<SessionContextSnapshot | null> {
  const rows = await sql`
    SELECT
      session_id,
      user_id,
      used_tokens,
      context_window,
      model,
      provider,
      through_message_id,
      latest_message_id,
      compacted_through_message_id,
      updated_at
    FROM session_context_snapshots
    WHERE session_id = ${sessionId} AND user_id = ${userId}`;
  return rows[0] ? snapshotRow(rows[0]) : null;
}

export async function upsertSessionContextSnapshot(
  input: UpsertSessionContextSnapshotInput,
): Promise<SessionContextSnapshot | null> {
  const rows = await sql`
    INSERT INTO session_context_snapshots (
      session_id,
      user_id,
      used_tokens,
      context_window,
      model,
      provider,
      through_message_id,
      latest_message_id,
      compacted_through_message_id
    )
    SELECT
      s.id,
      s.user_id,
      ${Math.max(0, Math.floor(input.usedTokens))},
      ${Math.max(1, Math.floor(input.contextWindow))},
      ${input.model},
      ${input.provider},
      ${Math.max(0, Math.floor(input.throughMessageId))},
      ${Math.max(input.throughMessageId, Math.floor(input.latestMessageId))},
      ${Math.max(0, Math.floor(input.compactedThroughMessageId))}
    FROM sessions s
    WHERE s.id = ${input.sessionId} AND s.user_id = ${input.userId}
    ON CONFLICT (session_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      used_tokens = EXCLUDED.used_tokens,
      context_window = EXCLUDED.context_window,
      model = EXCLUDED.model,
      provider = EXCLUDED.provider,
      through_message_id = EXCLUDED.through_message_id,
      latest_message_id = EXCLUDED.latest_message_id,
      compacted_through_message_id = EXCLUDED.compacted_through_message_id,
      updated_at = now()
    WHERE session_context_snapshots.user_id = EXCLUDED.user_id
      AND (
        EXCLUDED.through_message_id > session_context_snapshots.through_message_id
        OR (
          EXCLUDED.through_message_id = session_context_snapshots.through_message_id
          AND EXCLUDED.latest_message_id >= session_context_snapshots.latest_message_id
          AND EXCLUDED.compacted_through_message_id
            >= session_context_snapshots.compacted_through_message_id
        )
      )
    RETURNING
      session_id,
      user_id,
      used_tokens,
      context_window,
      model,
      provider,
      through_message_id,
      latest_message_id,
      compacted_through_message_id,
      updated_at`;
  return rows[0] ? snapshotRow(rows[0]) : null;
}
