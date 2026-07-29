import { sql } from "./db.ts";

function hashApiKey(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

export async function createApiKey(userId: string, rawKey: string, label = ""): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO api_keys (id, user_id, key_hash, label)
    VALUES (${id}, ${userId}, ${hashApiKey(rawKey)}, ${label})`;
  return id;
}

export async function verifyApiKey(rawKey: string): Promise<string | null> {
  const rows = await sql`
    SELECT user_id FROM api_keys
    WHERE key_hash = ${hashApiKey(rawKey)} AND revoked_at IS NULL
    LIMIT 1`;
  return rows[0]?.user_id ? String(rows[0].user_id) : null;
}

export async function revokeApiKey(id: string): Promise<void> {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id}`;
}

export async function assertSessionOwner(sessionId: string, userId: string): Promise<boolean> {
  const rows = await sql`SELECT user_id FROM sessions WHERE id = ${sessionId}`;
  if (!rows[0]) return false;
  return String(rows[0].user_id) === userId;
}
