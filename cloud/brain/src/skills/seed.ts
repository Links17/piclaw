/**
 * Seed built-in system skills from cloud/skills/system into PG.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as store from "@piclaw-cloud/store";

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

function resolveSystemSkillsDir(): string {
  return join(import.meta.dir, "../../../skills/system");
}

export async function seedSystemSkills(): Promise<number> {
  const root = resolveSystemSkillsDir();
  if (!existsSync(root)) return 0;

  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(root, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const content = readFileSync(skillPath, "utf8");
    const meta = parseFrontmatter(content);
    const name = meta.name ?? entry.name;
    await store.upsertSystemSkill({
      name,
      description: meta.description ?? "",
      content,
      source: "builtin",
      sourcePath: skillPath,
    });
    count += 1;
  }
  return count;
}
