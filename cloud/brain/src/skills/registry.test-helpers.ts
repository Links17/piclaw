import type { SkillRow } from "@piclaw-cloud/store";
import type { SkillCatalogEntry } from "./registry.ts";

export function mergeCatalogRowsForTest(rows: SkillRow[]): SkillCatalogEntry[] {
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
