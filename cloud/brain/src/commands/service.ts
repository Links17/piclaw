import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { listUserSkillsForApi } from "../skills/registry.ts";
import { buildCoreCommandList, type CommandEntry } from "./core-commands.ts";

export async function buildAgentCommandList(userId = DEFAULT_USER_ID): Promise<CommandEntry[]> {
  const entries = buildCoreCommandList();
  const seen = new Set(entries.map((entry) => entry.name.toLowerCase()));
  try {
    const skills = await listUserSkillsForApi(userId);
    for (const skill of skills) {
      const name = `/skill:${skill.name}`;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        name,
        description: skill.description || "skill",
        source: "skill",
      });
    }
  } catch {
    // skills optional
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
