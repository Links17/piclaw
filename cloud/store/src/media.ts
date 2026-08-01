import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { sql } from "./db.ts";

export interface MediaRow {
  id: number;
  user_id: string;
  filename: string;
  content_type: string;
  object_key: string;
  object_size: number;
  thumbnail_object_key: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface MediaInfo {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  has_thumbnail: boolean;
  created_at: string;
}

export async function createMedia(row: {
  userId?: string;
  filename: string;
  contentType: string;
  objectKey: string;
  objectSize: number;
  thumbnailObjectKey?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO media (user_id, filename, content_type, object_key, object_size, thumbnail_object_key, metadata)
    VALUES (
      ${row.userId ?? DEFAULT_USER_ID},
      ${row.filename},
      ${row.contentType},
      ${row.objectKey},
      ${row.objectSize},
      ${row.thumbnailObjectKey ?? null},
      ${row.metadata ? JSON.stringify(row.metadata) : null}
    )
    RETURNING id`;
  return Number(rows[0].id);
}

export async function getMediaById(id: number): Promise<MediaRow | null> {
  const rows = await sql`
    SELECT id, user_id, filename, content_type, object_key, object_size,
      thumbnail_object_key, metadata, created_at
    FROM media WHERE id = ${id}`;
  return mapMediaRow(rows[0]);
}

export async function getMediaByIdForUser(id: number, userId: string): Promise<MediaRow | null> {
  const rows = await sql`
    SELECT id, user_id, filename, content_type, object_key, object_size,
      thumbnail_object_key, metadata, created_at
    FROM media WHERE id = ${id} AND user_id = ${userId}`;
  return mapMediaRow(rows[0]);
}

function mapMediaRow(row: Record<string, unknown> | undefined): MediaRow | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    filename: String(row.filename),
    content_type: String(row.content_type),
    object_key: String(row.object_key ?? ""),
    object_size: Number(row.object_size),
    thumbnail_object_key: row.thumbnail_object_key ? String(row.thumbnail_object_key) : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null,
    created_at: String(row.created_at),
  };
}

export async function getMediaInfoById(id: number): Promise<MediaInfo | null> {
  const rows = await sql`
    SELECT id, filename, content_type,
      object_size AS size,
      (thumbnail_object_key IS NOT NULL) AS has_thumbnail, created_at
    FROM media WHERE id = ${id}`;
  return mapMediaInfo(rows[0]);
}

export async function getMediaInfoByIdForUser(id: number, userId: string): Promise<MediaInfo | null> {
  const rows = await sql`
    SELECT id, filename, content_type,
      object_size AS size,
      (thumbnail_object_key IS NOT NULL) AS has_thumbnail, created_at
    FROM media WHERE id = ${id} AND user_id = ${userId}`;
  return mapMediaInfo(rows[0]);
}

function mapMediaInfo(row: Record<string, unknown> | undefined): MediaInfo | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    filename: String(row.filename),
    content_type: String(row.content_type),
    size: Number(row.size),
    has_thumbnail: Boolean(row.has_thumbnail),
    created_at: String(row.created_at),
  };
}

export async function linkMessageMedia(messageId: number, mediaId: number): Promise<void> {
  await sql`
    INSERT INTO message_media (message_id, media_id)
    VALUES (${messageId}, ${mediaId})
    ON CONFLICT DO NOTHING`;
}
