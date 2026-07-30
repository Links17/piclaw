import { sql } from "./db.ts";

export type SkillScope = "system" | "user";
export type SkillSource = "builtin" | "installed" | "workspace";

export interface SkillRow {
  id: string;
  scope: SkillScope;
  user_id: string | null;
  name: string;
  description: string;
  content: string;
  source: SkillSource;
  source_path: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillPublicRow {
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
  source_path: string | null;
}

export interface SkillCatalogRow {
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
}

function systemSkillId(name: string): string {
  return `system:${name}`;
}

function userSkillId(userId: string, name: string): string {
  return `user:${userId}:${name}`;
}

export async function upsertSystemSkill(row: {
  name: string;
  description: string;
  content: string;
  source?: SkillSource;
  sourcePath?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO skills (id, scope, user_id, name, description, content, source, source_path, enabled)
    VALUES (
      ${systemSkillId(row.name)},
      'system',
      NULL,
      ${row.name},
      ${row.description},
      ${row.content},
      ${row.source ?? "builtin"},
      ${row.sourcePath ?? null},
      true
    )
    ON CONFLICT (id) DO UPDATE SET
      description = EXCLUDED.description,
      content = EXCLUDED.content,
      source = EXCLUDED.source,
      source_path = EXCLUDED.source_path,
      enabled = true,
      updated_at = now()`;
}

export async function upsertUserSkill(row: {
  userId: string;
  name: string;
  description: string;
  content: string;
  source?: SkillSource;
  sourcePath?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO skills (id, scope, user_id, name, description, content, source, source_path, enabled)
    VALUES (
      ${userSkillId(row.userId, row.name)},
      'user',
      ${row.userId},
      ${row.name},
      ${row.description},
      ${row.content},
      ${row.source ?? "installed"},
      ${row.sourcePath ?? null},
      true
    )
    ON CONFLICT (id) DO UPDATE SET
      description = EXCLUDED.description,
      content = EXCLUDED.content,
      source = EXCLUDED.source,
      source_path = EXCLUDED.source_path,
      enabled = true,
      updated_at = now()`;
}

export async function deleteUserSkill(userId: string, name: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM skills
    WHERE scope = 'user' AND user_id = ${userId} AND name = ${name}
    RETURNING id`;
  return rows.length > 0;
}

export async function listUserSkills(userId: string): Promise<SkillPublicRow[]> {
  const rows = await sql`
    SELECT name, description, source, enabled, source_path
    FROM skills
    WHERE scope = 'user' AND user_id = ${userId}
    ORDER BY name ASC`;
  return rows as SkillPublicRow[];
}

export async function listEnabledSkillsForUser(userId: string): Promise<SkillRow[]> {
  const rows = await sql`
    SELECT id, scope, user_id, name, description, content, source, source_path, enabled, created_at, updated_at
    FROM skills
    WHERE enabled = true AND (scope = 'system' OR (scope = 'user' AND user_id = ${userId}))
    ORDER BY scope ASC, name ASC`;
  return rows as SkillRow[];
}

export async function getSkillContentForUser(userId: string, name: string): Promise<SkillRow | null> {
  const userRows = await sql`
    SELECT id, scope, user_id, name, description, content, source, source_path, enabled, created_at, updated_at
    FROM skills
    WHERE scope = 'user' AND user_id = ${userId} AND name = ${name} AND enabled = true
    LIMIT 1`;
  if (userRows[0]) return userRows[0] as SkillRow;

  const systemRows = await sql`
    SELECT id, scope, user_id, name, description, content, source, source_path, enabled, created_at, updated_at
    FROM skills
    WHERE scope = 'system' AND name = ${name} AND enabled = true
    LIMIT 1`;
  return (systemRows[0] as SkillRow) ?? null;
}

export async function getSkillContentsForUser(userId: string, names: string[]): Promise<SkillRow[]> {
  const results: SkillRow[] = [];
  for (const name of names) {
    const row = await getSkillContentForUser(userId, name);
    if (row) results.push(row);
  }
  return results;
}
