/**
 * Custom agent type discovery + schedule helper (P2c-4 subset).
 */
import * as store from "@piclaw-cloud/store";
import { readFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";

export interface CustomAgentType {
  name: string;
  description: string;
  prompt: string;
  skills: string[];
  subagentType: "general-purpose" | "explore" | "plan";
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function parseAgentFrontmatter(content: string): Partial<CustomAgentType> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const block = match[1] ?? "";
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const subagentType = block.match(/^subagent_type:\s*(.+)$/m)?.[1]?.trim();
  const skills = block.match(/^skills:\s*\[(.*)\]$/m)?.[1];
  return {
    name,
    description,
    subagentType:
      subagentType === "explore" || subagentType === "plan" ? subagentType : "general-purpose",
    skills: skills ? skills.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")) : [],
  };
}

export async function discoverCustomAgentTypes(sessionId: string): Promise<CustomAgentType[]> {
  const sbx = await ensureSandbox(sessionId);
  const listing = await sbx.commands.run(
    "find /workspace/.pi/agents -maxdepth 2 -name '*.md' 2>/dev/null || true",
    { timeoutMs: 15_000 },
  );
  const paths = listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const agents: CustomAgentType[] = [];
  for (const path of paths) {
    try {
      const content = String(await readFile(sbx, path));
      const meta = parseAgentFrontmatter(content);
      const body = content.replace(FRONTMATTER_RE, "").trim();
      agents.push({
        name: meta.name ?? path.split("/").pop()?.replace(/\.md$/, "") ?? "agent",
        description: meta.description ?? "",
        prompt: body,
        skills: meta.skills ?? [],
        subagentType: meta.subagentType ?? "general-purpose",
      });
    } catch {
      // skip
    }
  }
  return agents;
}

export async function scheduleAgentTask(
  sessionId: string,
  row: {
    id: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    nextRun?: Date | null;
  },
): Promise<void> {
  await store.createScheduledTask({
    id: row.id,
    sessionId,
    prompt: row.prompt,
    scheduleType: row.scheduleType,
    scheduleValue: row.scheduleValue,
    nextRun: row.nextRun ?? null,
  });
}
