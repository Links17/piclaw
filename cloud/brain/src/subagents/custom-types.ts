/**
 * Custom agent type discovery + schedule helper (P2c-4 subset).
 */
import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { readFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";

export interface CustomAgentType {
  name: string;
  description: string;
  prompt: string;
  skills: string[];
  subagentType: "general-purpose" | "explore" | "plan" | "research";
  tools?: string[];
  promptMode?: "replace" | "append";
  maxTurns?: number;
  model?: string;
  thinking?: string;
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
  const tools = block.match(/^tools:\s*\[(.*)\]$/m)?.[1];
  const promptMode = block.match(/^prompt_mode:\s*(.+)$/m)?.[1]?.trim();
  const maxTurnsRaw = block.match(/^max_turns:\s*(\d+)\s*$/m)?.[1];
  const model = block.match(/^model:\s*(.+)$/m)?.[1]?.trim();
  const thinking = block.match(/^thinking:\s*(.+)$/m)?.[1]?.trim();
  return {
    name,
    description,
    subagentType:
      subagentType === "explore" || subagentType === "plan" || subagentType === "research"
        ? subagentType
        : "general-purpose",
    skills: skills ? skills.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")) : [],
    tools: tools ? tools.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")) : undefined,
    promptMode: promptMode === "append" ? "append" : promptMode === "replace" ? "replace" : undefined,
    maxTurns: maxTurnsRaw ? Number(maxTurnsRaw) : undefined,
    model,
    thinking,
  };
}

export async function discoverCustomAgentTypes(sessionId: string): Promise<CustomAgentType[]> {
  if (!config.sandboxEnabled) return [];
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
        tools: meta.tools,
        promptMode: meta.promptMode,
        maxTurns: meta.maxTurns,
        model: meta.model,
        thinking: meta.thinking,
      });
    } catch {
      // skip
    }
  }
  return agents;
}

export async function discoverCustomAgentTypesIfNeeded(
  sessionId: string,
  requestedType: string,
): Promise<CustomAgentType[]> {
  if (requestedType === "general-purpose"
    || requestedType === "explore"
    || requestedType === "plan"
    || requestedType === "research"
    || requestedType === "coding") {
    return [];
  }
  return discoverCustomAgentTypes(sessionId);
}

export async function scheduleAgentTask(
  sessionId: string,
  row: {
    id: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    nextRun?: Date | null;
    timezone?: string | null;
    invocation?: object | null;
  },
): Promise<void> {
  const task: Parameters<typeof store.createScheduledTask>[0] = {
    id: row.id,
    sessionId,
    prompt: row.prompt,
    scheduleType: row.scheduleType,
    scheduleValue: row.scheduleValue,
    nextRun: row.nextRun ?? null,
  };
  if (Object.prototype.hasOwnProperty.call(row, "timezone")) task.timezone = row.timezone ?? null;
  if (Object.prototype.hasOwnProperty.call(row, "invocation")) task.invocation = row.invocation ?? null;
  await store.createScheduledTask(task);
}
