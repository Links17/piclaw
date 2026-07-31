import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import {
  formatAgentToolResult,
  getSubagentResult,
  spawnAgent,
  steerSubagent,
} from "../subagents/manager.ts";
import { normalizeSubagentRunId } from "../subagents/run-id.ts";
import type { AgentToolOptions } from "../subagents/types.ts";
import { applyUniqueEdit } from "./edit.ts";
import { config } from "../config.ts";
import { isLlmMockEnabled } from "../llm.ts";
import { publish } from "../events.ts";
import { publishWorkspaceUpdate } from "../workspace/publish.ts";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./path.ts";
import { runQuestionTool } from "./question.ts";
import { runSkillTool } from "./skill.ts";
import { runTodoTool } from "./todo.ts";
import { toolNamesForMode, type ToolDefinition } from "./schemas.ts";
import { getMcpToolDefinitions, invokeMcpTool } from "../mcp/client.ts";
import { TurnAbortedError, assertTurnNotAborted, isTurnAborted, waitForTurnAbort } from "../turn-abort.ts";

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

async function killSandboxCommandBestEffort(sbx: Awaited<ReturnType<typeof ensureSandbox>>): Promise<void> {
  try {
    await sbx.commands.run("pkill -P 1 2>/dev/null || true", { timeoutMs: 5_000 });
  } catch {
    // best-effort
  }
}

function mockSandboxToolResult(name: string, args: Record<string, unknown>): ToolDispatchResult | null {
  if (!isLlmMockEnabled() || config.sandboxEnabled) return null;
  if (name === "bash") {
    return { output: `$ ${String(args.command ?? "")}\n(mock ok)\n(exit 0)`, isError: false };
  }
  if (name === "read") {
    return { output: `(mock file ${String(args.path ?? "")})`, isError: false };
  }
  if (name === "write") {
    return { output: `Mock wrote ${String(args.path ?? "")}`, isError: false };
  }
  if (name === "edit") {
    return { output: `Mock edited ${String(args.path ?? "")}`, isError: false };
  }
  return null;
}

async function runBashTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const mocked = mockSandboxToolResult("bash", args);
  if (mocked) return mocked;
  assertTurnNotAborted(sessionId);
  const command = String(args.command ?? "").trim();
  if (!command) return { output: "command is required", isError: true };
  const sbx = await ensureSandbox(sessionId);
  const wrapped = `cd ${WORKSPACE_ROOT} && ${command}`;
  const runPromise = sbx.commands.run(wrapped, { timeoutMs: 120_000 });
  await Promise.race([runPromise, waitForTurnAbort(sessionId)]);
  if (isTurnAborted(sessionId)) {
    void killSandboxCommandBestEffort(sbx);
    throw new TurnAbortedError();
  }
  const result = await runPromise;
  const parts = [`$ ${command}`];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.exitCode})`);
  return { output: truncate(parts.join("\n")), isError: result.exitCode !== 0 };
}

async function runReadTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const mocked = mockSandboxToolResult("read", args);
  if (mocked) return mocked;
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const sbx = await ensureSandbox(sessionId);
  const content = await readFile(sbx, path);
  return { output: truncate(String(content)), isError: false };
}


async function runWriteTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const mocked = mockSandboxToolResult("write", args);
  if (mocked) return mocked;
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const content = String(args.content ?? "");
  const sbx = await ensureSandbox(sessionId);
  await writeFile(sbx, path, content);
  await publishWorkspaceUpdate(sessionId, path);
  return { output: `Wrote ${content.length} bytes to ${path}`, isError: false };
}

async function runEditTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const mocked = mockSandboxToolResult("edit", args);
  if (mocked) return mocked;
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const sbx = await ensureSandbox(sessionId);
  const current = await readFile(sbx, path);
  const updated = applyUniqueEdit(String(current), oldString, newString);
  await writeFile(sbx, path, updated);
  await publishWorkspaceUpdate(sessionId, path);
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
  const outcome = await spawnAgent(sessionId, {
    prompt: task,
    description: constraints ?? task,
    subagentType: "general-purpose",
    timeoutMs,
    runInBackground: false,
  });
  const isError = outcome.status === "failed" || outcome.status === "timed_out" || outcome.status === "stopped";
  return {
    output: formatAgentToolResult(outcome),
    isError,
  };
}

export async function getDispatchMcpTools(): Promise<ToolDefinition[]> {
  return getMcpToolDefinitions();
}
