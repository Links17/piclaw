import { sql } from "./db.ts";

export interface UserPreferences {
  scopedModelsOnly?: boolean;
  searchMatchMode?: string;
}

export interface SessionModelPrefs {
  modelLabel: string | null;
  thinkingLevel: string | null;
}

function parsePreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.scopedModelsOnly === "boolean" ? { scopedModelsOnly: raw.scopedModelsOnly } : {}),
    ...(typeof raw.searchMatchMode === "string" ? { searchMatchMode: raw.searchMatchMode } : {}),
  };
}

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const rows = await sql`SELECT preferences FROM users WHERE id = ${userId}`;
  return parsePreferences(rows[0]?.preferences);
}

export async function updateUserPreferences(
  userId: string,
  patch: UserPreferences,
): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const next = { ...current, ...patch };
  await sql`
    UPDATE users
    SET preferences = ${JSON.stringify(next)}::jsonb
    WHERE id = ${userId}`;
  return next;
}

export async function getSessionModelPrefs(sessionId: string): Promise<SessionModelPrefs> {
  const rows = await sql`
    SELECT model_label, thinking_level FROM sessions WHERE id = ${sessionId}`;
  const row = rows[0];
  return {
    modelLabel: row?.model_label == null ? null : String(row.model_label),
    thinkingLevel: row?.thinking_level == null ? null : String(row.thinking_level),
  };
}

export async function setSessionModelLabel(sessionId: string, modelLabel: string | null): Promise<void> {
  await sql`
    UPDATE sessions SET model_label = ${modelLabel}, updated_at = now()
    WHERE id = ${sessionId}`;
}

export async function setSessionThinkingLevel(sessionId: string, level: string | null): Promise<void> {
  await sql`
    UPDATE sessions SET thinking_level = ${level}, updated_at = now()
    WHERE id = ${sessionId}`;
}
