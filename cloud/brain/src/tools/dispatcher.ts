import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { formatCodingSubagentToolResult, runCodingSubagent } from "../subagents/gateway.ts";
import {
  formatAgentToolResult,
  getSubagentResult,
  spawnAgent,
  steerSubagent,
} from "../subagents/manager.ts";
import { normalizeSubagentRunId } from "../subagents/run-id.ts";
import type { AgentToolOptions } from "../subagents/types.ts";
import { applyUniqueEdit } from "./edit.ts";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./path.ts";
import { runQuestionTool } from "./question.ts";
import { runSkillTool } from "./skill.ts";
import { runTodoTool } from "./todo.ts";
import { toolNamesForMode, type ToolDefinition } from "./schemas.ts";
import { getMcpToolDefinitions, invokeMcpTool } from "../mcp/client.ts";
import { TurnAbortedError } from "../turn-abort.ts";

const MAX_OUTPUT_CHARS = 32_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

export interface ToolDispatchResult {
  output: string;
  isError: boolean;
}

export interface ToolDispatchContext {
  sessionMode?: "plan" | "execute";
  mcpTools?: ToolDefinition[];
}

export async function dispatchTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  sessionMode: "plan" | "execute" = "execute",
  mcpTools: ToolDefinition[] = [],
): Promise<ToolDispatchResult> {
  const allowed = toolNamesForMode(sessionMode, mcpTools);
  if (!allowed.has(name)) {
    return { output: `Tool not available in ${sessionMode} mode: ${name}`, isError: true };
  }

  if (name.startsWith("mcp__")) {
    return invokeMcpTool(name, args);
  }

  try {
    switch (name) {
      case "bash":
        return await runBashTool(sessionId, args);
      case "read":
        return await runReadTool(sessionId, args);
      case "write":
        return await runWriteTool(sessionId, args);
      case "edit":
        return await runEditTool(sessionId, args);
      case "question":
        return await runQuestionTool(sessionId, args as never);
      case "todo":
        return await runTodoTool(sessionId, args as never);
      case "skill":
        return await runSkillTool(sessionId, args as never);
      case "Agent":
        return await runAgentTool(sessionId, args);
      case "coding_agent":
        return await runCodingAgentTool(sessionId, args);
      case "get_subagent_result":
        return await getSubagentResult(sessionId, String(args.agent_id ?? ""), {
          wait: Boolean(args.wait),
          verbose: Boolean(args.verbose),
        });
      case "steer_subagent":
        return await steerSubagent(sessionId, String(args.agent_id ?? ""), String(args.message ?? ""));
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    if (error instanceof TurnAbortedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { output: message, isError: true };
  }
}

async function runBashTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const command = String(args.command ?? "").trim();
  if (!command) return { output: "command is required", isError: true };
  const sbx = await ensureSandbox(sessionId);
  const wrapped = `cd ${WORKSPACE_ROOT} && ${command}`;
  const result = await sbx.commands.run(wrapped, { timeoutMs: 120_000 });
  const parts = [`$ ${command}`];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.exitCode})`);
  return { output: truncate(parts.join("\n")), isError: result.exitCode !== 0 };
}

async function runReadTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const sbx = await ensureSandbox(sessionId);
  const content = await readFile(sbx, path);
  return { output: truncate(String(content)), isError: false };
}

async function runWriteTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const content = String(args.content ?? "");
  const sbx = await ensureSandbox(sessionId);
  await writeFile(sbx, path, content);
  return { output: `Wrote ${content.length} bytes to ${path}`, isError: false };
}

async function runEditTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const sbx = await ensureSandbox(sessionId);
  const current = await readFile(sbx, path);
  const updated = applyUniqueEdit(String(current), oldString, newString);
  await writeFile(sbx, path, updated);
  return { output: `Edited ${path}`, isError: false };
}

async function runAgentTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const prompt = String(args.prompt ?? "").trim();
  const description = String(args.description ?? "").trim();
  const subagentType = String(args.subagent_type ?? "general-purpose") as AgentToolOptions["subagentType"];
  if (!prompt) return { output: "prompt is required", isError: true };
  if (!description) return { output: "description is required", isError: true };

  const options: AgentToolOptions = {
    prompt,
    description,
    subagentType,
    model: typeof args.model === "string" ? args.model : undefined,
    maxTurns: typeof args.max_turns === "number" ? args.max_turns : undefined,
    runInBackground: Boolean(args.run_in_background),
    resume: normalizeSubagentRunId(typeof args.resume === "string" ? args.resume : undefined) ?? undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    schedule: typeof args.schedule === "string" ? args.schedule : undefined,
  };
  const outcome = await spawnAgent(sessionId, options);
  const isError = outcome.status === "failed" || outcome.status === "timed_out";
  return {
    output: formatAgentToolResult(outcome),
    isError,
  };
}

async function runCodingAgentTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const task = String(args.task ?? "").trim();
  if (!task) return { output: "task is required", isError: true };
  const constraints = typeof args.constraints === "string" ? args.constraints : undefined;
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
  const result = await runCodingSubagent(sessionId, { task, constraints, timeoutMs });
  const isError = result.status !== "completed";
  return {
    output: formatCodingSubagentToolResult(result),
    isError,
  };
}

export async function getDispatchMcpTools(): Promise<ToolDefinition[]> {
  return getMcpToolDefinitions();
}
