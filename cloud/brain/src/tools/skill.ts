import * as store from "@piclaw-cloud/store";
import { getSkillContent } from "../skills/registry.ts";

const MAX_SKILL_CHARS = 32_000;

export async function runSkillTool(
  sessionId: string,
  args: { name?: string },
): Promise<{ output: string; isError: boolean }> {
  const name = String(args.name ?? "").trim();
  if (!name) return { output: "name is required", isError: true };

  const session = await store.getSession(sessionId);
  if (!session) return { output: `unknown session ${sessionId}`, isError: true };

  const skill = await getSkillContent(name, session.user_id);
  if (!skill) {
    return { output: `Unknown skill: ${name}`, isError: true };
  }

  const content = skill.content.length > MAX_SKILL_CHARS
    ? `${skill.content.slice(0, MAX_SKILL_CHARS)}\n...[truncated]`
    : skill.content;

  return {
    output: `# Skill: ${skill.name}\n\n${content}`,
    isError: false,
  };
}
