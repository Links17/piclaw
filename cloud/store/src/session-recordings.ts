import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { sql } from "./db.ts";

export type SessionRecordingMode = "metadata" | "redacted" | "full";
export type SessionRecordingStatus = "recording" | "stopped";

export interface SessionRecordingRedactionOptions {
  patterns?: string[];
  keys?: string[];
  maxStringLength?: number;
}

export interface SessionRecordingMeta {
  id: string;
  chatJid: string;
  title: string;
  mode: SessionRecordingMode;
  status: SessionRecordingStatus;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  tracePath: string;
  redaction?: SessionRecordingRedactionOptions;
}

export interface SessionTraceEvent {
  version: number;
  recording_id: string;
  seq: number;
  kind: string;
  chat_jid: string;
  at: string;
  t_ms: number;
  data: unknown;
  redactions?: string[];
}

function rowToMeta(row: Record<string, unknown>): SessionRecordingMeta {
  const redaction = row.redaction && typeof row.redaction === "object"
    ? row.redaction as SessionRecordingRedactionOptions
    : undefined;
  const id = String(row.id);
  return {
    id,
    chatJid: String(row.chat_jid),
    title: String(row.title),
    mode: String(row.mode) as SessionRecordingMode,
    status: String(row.status) as SessionRecordingStatus,
    startedAt: new Date(String(row.started_at)).toISOString(),
    endedAt: row.ended_at ? new Date(String(row.ended_at)).toISOString() : undefined,
    eventCount: Number(row.event_count ?? 0),
    tracePath: `pg://${id}`,
    ...(redaction ? { redaction } : {}),
  };
}

export async function createSessionRecording(row: {
  id: string;
  chatJid: string;
  title: string;
  mode: SessionRecordingMode;
  redaction?: SessionRecordingRedactionOptions;
  userId?: string;
}): Promise<SessionRecordingMeta> {
  await sql`
    INSERT INTO session_recordings (id, user_id, chat_jid, title, mode, status, redaction)
    VALUES (
      ${row.id},
      ${row.userId ?? DEFAULT_USER_ID},
      ${row.chatJid},
      ${row.title},
      ${row.mode},
      'recording',
      ${row.redaction ? JSON.stringify(row.redaction) : null}
    )`;
  const meta = await getSessionRecordingMeta(row.id);
  if (!meta) throw new Error("Failed to create session recording.");
  return meta;
}

export async function updateSessionRecordingMeta(meta: SessionRecordingMeta): Promise<void> {
  await sql`
    UPDATE session_recordings
    SET title = ${meta.title},
        mode = ${meta.mode},
        status = ${meta.status},
        ended_at = ${meta.endedAt ?? null},
        event_count = ${meta.eventCount},
        redaction = ${meta.redaction ? JSON.stringify(meta.redaction) : null}
    WHERE id = ${meta.id}`;
}

export async function appendSessionRecordingEvent(event: SessionTraceEvent): Promise<void> {
  await sql`
    INSERT INTO session_recording_events (
      recording_id, seq, version, kind, chat_jid, at, t_ms, data, redactions
    ) VALUES (
      ${event.recording_id},
      ${event.seq},
      ${event.version},
      ${event.kind},
      ${event.chat_jid},
      ${event.at},
      ${event.t_ms},
      ${JSON.stringify(event.data)},
      ${event.redactions?.length ? JSON.stringify(event.redactions) : null}
    )`;
  await sql`
    UPDATE session_recordings
    SET event_count = ${event.seq}
    WHERE id = ${event.recording_id}`;
}

export async function listSessionRecordings(limit = 200): Promise<SessionRecordingMeta[]> {
  const rows = await sql`
    SELECT * FROM session_recordings
    ORDER BY started_at DESC
    LIMIT ${limit}`;
  return rows.map((row: Record<string, unknown>) => rowToMeta(row));
}

export async function listSessionRecordingsForUser(
  userId: string,
  limit = 200,
): Promise<SessionRecordingMeta[]> {
  const rows = await sql`
    SELECT * FROM session_recordings
    WHERE user_id = ${userId}
    ORDER BY started_at DESC
    LIMIT ${limit}`;
  return rows.map((row: Record<string, unknown>) => rowToMeta(row));
}

export async function listActiveSessionRecordings(): Promise<SessionRecordingMeta[]> {
  const rows = await sql`
    SELECT * FROM session_recordings
    WHERE status = 'recording'
    ORDER BY started_at DESC`;
  return rows.map((row: Record<string, unknown>) => rowToMeta(row));
}

export async function listActiveSessionRecordingsForUser(userId: string): Promise<SessionRecordingMeta[]> {
  const rows = await sql`
    SELECT * FROM session_recordings
    WHERE user_id = ${userId} AND status = 'recording'
    ORDER BY started_at DESC`;
  return rows.map((row: Record<string, unknown>) => rowToMeta(row));
}

export async function getSessionRecordingMeta(id: string): Promise<SessionRecordingMeta | null> {
  const rows = await sql`SELECT * FROM session_recordings WHERE id = ${id}`;
  const row = rows[0];
  return row ? rowToMeta(row as Record<string, unknown>) : null;
}

export async function getSessionRecordingMetaForUser(
  id: string,
  userId: string,
): Promise<SessionRecordingMeta | null> {
  const rows = await sql`
    SELECT * FROM session_recordings WHERE id = ${id} AND user_id = ${userId}`;
  const row = rows[0];
  return row ? rowToMeta(row as Record<string, unknown>) : null;
}

export async function getActiveSessionRecording(chatJid: string): Promise<SessionRecordingMeta | null> {
  const rows = await sql`
    SELECT * FROM session_recordings
    WHERE chat_jid = ${chatJid} AND status = 'recording'
    ORDER BY started_at DESC
    LIMIT 1`;
  const row = rows[0];
  return row ? rowToMeta(row as Record<string, unknown>) : null;
}

export async function getActiveSessionRecordingForUser(
  chatJid: string,
  userId: string,
): Promise<SessionRecordingMeta | null> {
  const rows = await sql`
    SELECT * FROM session_recordings
    WHERE chat_jid = ${chatJid} AND user_id = ${userId} AND status = 'recording'
    ORDER BY started_at DESC
    LIMIT 1`;
  const row = rows[0];
  return row ? rowToMeta(row as Record<string, unknown>) : null;
}

export async function listSessionRecordingEvents(recordingId: string): Promise<SessionTraceEvent[]> {
  const rows = await sql`
    SELECT * FROM session_recording_events
    WHERE recording_id = ${recordingId}
    ORDER BY seq ASC`;
  return rows.map((row: Record<string, unknown>) => ({
    version: Number(row.version ?? 1),
    recording_id: String(row.recording_id),
    seq: Number(row.seq),
    kind: String(row.kind),
    chat_jid: String(row.chat_jid),
    at: new Date(String(row.at)).toISOString(),
    t_ms: Number(row.t_ms),
    data: row.data ?? null,
    ...(Array.isArray(row.redactions) ? { redactions: row.redactions as string[] } : {}),
  }));
}

export async function listSessionRecordingEventsForUser(
  recordingId: string,
  userId: string,
): Promise<SessionTraceEvent[]> {
  const owned = await getSessionRecordingMetaForUser(recordingId, userId);
  if (!owned) return [];
  return listSessionRecordingEvents(recordingId);
}

export async function deleteSessionRecording(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM session_recordings WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deleteSessionRecordingForUser(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM session_recordings WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}
