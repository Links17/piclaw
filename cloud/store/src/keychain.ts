import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { sql } from "./db.ts";

export type KeychainEntryType = "token" | "password" | "basic" | "secret";

export interface KeychainEntryRow {
  userId: string;
  name: string;
  type: KeychainEntryType;
  username: string | null;
  userNote: string | null;
  agentNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KeychainEntryUi extends KeychainEntryRow {
  envVar: string | null;
  hasSecret: boolean;
}

const DEV_KEYCHAIN_SALT = "piclaw-cloud-keychain-v1";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, DEV_KEYCHAIN_SALT, 32);
}

function encryptSecret(plain: string, encryptionKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(payload: string, encryptionKey: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(encryptionKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function rowToUi(row: Record<string, unknown>): KeychainEntryUi {
  return {
    userId: String(row.user_id),
    name: String(row.name),
    type: String(row.type) as KeychainEntryType,
    username: row.username == null ? null : String(row.username),
    userNote: row.user_note == null ? null : String(row.user_note),
    agentNote: row.agent_note == null ? null : String(row.agent_note),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    envVar: null,
    hasSecret: Boolean(row.secret_encrypted),
  };
}

export async function listKeychainEntries(userId = DEFAULT_USER_ID): Promise<KeychainEntryUi[]> {
  const rows = await sql`
    SELECT user_id, name, type, username, user_note, agent_note, secret_encrypted, created_at, updated_at
    FROM user_keychain
    WHERE user_id = ${userId}
    ORDER BY name ASC`;
  return rows.map((row: Record<string, unknown>) => rowToUi(row));
}

export async function setKeychainEntry(
  input: {
    name: string;
    type: KeychainEntryType;
    secret: string;
    username?: string;
    userNote?: string;
    agentNote?: string;
  },
  userId = DEFAULT_USER_ID,
  encryptionKey: string,
): Promise<void> {
  const encrypted = encryptSecret(input.secret, encryptionKey);
  await sql`
    INSERT INTO user_keychain (user_id, name, type, secret_encrypted, username, user_note, agent_note)
    VALUES (
      ${userId},
      ${input.name},
      ${input.type},
      ${encrypted},
      ${input.username ?? null},
      ${input.userNote ?? null},
      ${input.agentNote ?? null}
    )
    ON CONFLICT (user_id, name) DO UPDATE SET
      type = EXCLUDED.type,
      secret_encrypted = EXCLUDED.secret_encrypted,
      username = EXCLUDED.username,
      user_note = EXCLUDED.user_note,
      agent_note = EXCLUDED.agent_note,
      updated_at = now()`;
}

export async function deleteKeychainEntry(name: string, userId = DEFAULT_USER_ID): Promise<boolean> {
  const rows = await sql`
    DELETE FROM user_keychain WHERE user_id = ${userId} AND name = ${name} RETURNING name`;
  return rows.length > 0;
}

export async function updateKeychainNotes(
  name: string,
  notes: { userNote?: string; agentNote?: string },
  userId = DEFAULT_USER_ID,
): Promise<boolean> {
  const rows = await sql`
    UPDATE user_keychain
    SET user_note = COALESCE(${notes.userNote ?? null}, user_note),
        agent_note = COALESCE(${notes.agentNote ?? null}, agent_note),
        updated_at = now()
    WHERE user_id = ${userId} AND name = ${name}
    RETURNING name`;
  return rows.length > 0;
}

export async function revealKeychainSecret(
  name: string,
  userId = DEFAULT_USER_ID,
  encryptionKey: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT secret_encrypted FROM user_keychain
    WHERE user_id = ${userId} AND name = ${name}`;
  const payload = rows[0]?.secret_encrypted;
  if (typeof payload !== "string" || !payload) return null;
  return decryptSecret(payload, encryptionKey);
}
