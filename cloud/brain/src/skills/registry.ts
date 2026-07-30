/**
 * Skill registry — system/user scopes, prompt catalog, dynamic loading.
 */
import * as store from "@piclaw-cloud/store";
import type { SkillPublicRow, SkillRow } from "@piclaw-cloud/store";
import { readFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { getCachedCatalog, invalidateSkillCache, setCachedCatalog } from "./cache.ts";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  scope: "system" | "user";
  source: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const block = match[1] ?? "";
  return {
    name: block.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: block.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
  };
}

function mergeCatalogRows(rows: SkillRow[]): SkillCatalogEntry[] {
  const byName = new Map<string, SkillCatalogEntry>();
  for (const row of rows) {
    if (row.scope === "system") {
      byName.set(row.name, {
        name: row.name,
        description: row.description,
        scope: "system",
        source: row.source,
      });
    }
  }
  for (const row of rows) {
    if (row.scope === "user") {
      byName.set(row.name, {
        name: row.name,
        description: row.description,
        scope: "user",
        source: row.source,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function syncWorkspaceSkills(sessionId: string, userId: string): Promise<void> {
  const sbx = await ensureSandbox(sessionId);
  const roots = ["/workspace/.pi/skills", "/workspace/.agents/skills"];

  for (const root of roots) {
    let paths: string[] = [];
    try {
      const listing = await sbx.commands.run(`find ${root} -maxdepth 2 -name 'SKILL.md' 2>/dev/null || true`, {
        timeoutMs: 15_000,
      });
      paths = listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      // sandbox may not have skills yet
    }

    for (const skillPath of paths) {
      try {
        const content = String(await readFile(sbx, skillPath));
        const meta = parseFrontmatter(content);
        const name = meta.name ?? skillPath.split("/").slice(-2, -1)[0] ?? "skill";
        await store.upsertUserSkill({
          userId,
          name,
          description: meta.description ?? "Skill available in workspace",
          content,
          source: "workspace",
          sourcePath: skillPath,
        });
      } catch {
        // skip unreadable skills
      }
    }
  }
}

export async function getPromptCatalog(userId: string, sessionId?: string): Promise<SkillCatalogEntry[]> {
  const cached = getCachedCatalog(userId);
  if (cached) return cached;

  if (sessionId) {
    await syncWorkspaceSkills(sessionId, userId);
    invalidateSkillCache(userId);
  }

  const rows = await store.listEnabledSkillsForUser(userId);
  const catalog = mergeCatalogRows(rows);
  setCachedCatalog(userId, catalog);
  return catalog;
}

export async function getSkillContent(name: string, userId: string): Promise<SkillRow | null> {
  return store.getSkillContentForUser(userId, name);
}

export function formatSkillsForPrompt(entries: SkillCatalogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["Available skills (use the skill tool with the skill name to load full instructions):"];
  for (const entry of entries) {
    lines.push(`- ${entry.name}: ${entry.description}`);
  }
  return lines.join("\n");
}

export async function buildSkillsPromptSection(sessionId: string, userId: string): Promise<string> {
  const catalog = await getPromptCatalog(userId, sessionId);
  return formatSkillsForPrompt(catalog);
}

export async function buildSkillPreloadSection(userId: string, skillNames: string[]): Promise<string> {
  if (skillNames.length === 0) return "";
  const rows = await store.getSkillContentsForUser(userId, skillNames);
  if (rows.length === 0) return "";
  const parts = ["Preloaded skills:"];
  for (const row of rows) {
    parts.push(`## Skill: ${row.name}\n${row.content.trim()}`);
  }
  return parts.join("\n\n");
}

export async function listUserSkillsForApi(userId: string): Promise<SkillPublicRow[]> {
  return store.listUserSkills(userId);
}

export async function installUserSkill(
  userId: string,
  body: { name: string; description?: string; content: string },
): Promise<void> {
  await store.upsertUserSkill({
    userId,
    name: body.name,
    description: body.description ?? "",
    content: body.content,
    source: "installed",
  });
  invalidateSkillCache(userId);
}

export async function deleteUserSkill(userId: string, name: string): Promise<boolean> {
  const deleted = await store.deleteUserSkill(userId, name);
  if (deleted) invalidateSkillCache(userId);
  return deleted;
}

export { invalidateSkillCache };
