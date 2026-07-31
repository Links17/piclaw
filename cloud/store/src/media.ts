import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { sql } from "./db.ts";

export interface MediaRow {
  id: number;
  user_id: string;
  filename: string;
  content_type: string;
  data: Uint8Array;
  thumbnail: Uint8Array | null;
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
  data: Uint8Array;
  thumbnail?: Uint8Array | null;
  metadata?: Record<string, unknown> | null;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO media (user_id, filename, content_type, data, thumbnail, metadata)
    VALUES (
      ${row.userId ?? DEFAULT_USER_ID},
      ${row.filename},
      ${row.contentType},
      ${row.data},
      ${row.thumbnail ?? null},
      ${row.metadata ? JSON.stringify(row.metadata) : null}
    )
    RETURNING id`;
  return Number(rows[0].id);
}

export async function getMediaById(id: number): Promise<MediaRow | null> {
  const rows = await sql`SELECT * FROM media WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    filename: String(row.filename),
    content_type: String(row.content_type),
    data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as ArrayBuffer),
    thumbnail: row.thumbnail
      ? (row.thumbnail instanceof Uint8Array ? row.thumbnail : new Uint8Array(row.thumbnail as ArrayBuffer))
      : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null,
    created_at: String(row.created_at),
  };
}

export async function getMediaInfoById(id: number): Promise<MediaInfo | null> {
  const rows = await sql`
    SELECT id, filename, content_type, octet_length(data) AS size, thumbnail IS NOT NULL AS has_thumbnail, created_at
    FROM media WHERE id = ${id}`;
  const row = rows[0];
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
