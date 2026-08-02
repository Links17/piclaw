import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import {
  formatAgentToolResult,
  getSubagentResult,
  spawnAgent,
  steerSubagent,
} from "../subagents/service.ts";
import { normalizeAgentSchedule } from "../subagents/schedule.ts";
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
import {
  activatableToolNames,
  getToolCatalog,
  toolNamesForMode,
  type ToolDefinition,
} from "./schemas.ts";
import {
  activateToolNames,
  getActiveToolNames,
  resetActiveToolNames,
} from "./active.ts";
import { getMcpToolDefinitions, invokeMcpTool } from "../mcp/client.ts";
import { TurnAbortedError, assertTurnNotAborted, isTurnAborted, waitForTurnAbort } from "../turn-abort.ts";
import * as store from "@piclaw-cloud/store";

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
  strictAllowedNames?: ReadonlySet<string>,
): Promise<ToolDispatchResult> {
  if (strictAllowedNames && !strictAllowedNames.has(name)) {
    return { output: `Tool not available in strict profile: ${name}`, isError: true };
  }
  const activeTools = getActiveToolNames(sessionId);
  const allowed = toolNamesForMode(sessionMode, mcpTools, activeTools);
  if (!allowed.has(name)) {
    return { output: `Tool not available in ${sessionMode} mode: ${name}`, isError: true };
  }

  if (name.startsWith("mcp__")) {
    return invokeMcpTool(name, args);
  }

  try {
    switch (name) {
      case "list_tools":
        return {
          output: JSON.stringify({
            active: [...activeTools].sort(),
            available: getToolCatalog(mcpTools),
          }),
          isError: false,
        };
      case "activate_tools":
        return runActivateToolsTool(sessionId, args, mcpTools);
      case "reset_active_tools":
        resetActiveToolNames(sessionId);
        return { output: "Active tools reset to the baseline set.", isError: false };
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
      case "scheduled_tasks":
        return await runScheduledTasksTool(sessionId, args);
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

function runActivateToolsTool(
  sessionId: string,
  args: Record<string, unknown>,
  mcpTools: ToolDefinition[],
): ToolDispatchResult {
  const rawNames = args.names;
  if (!Array.isArray(rawNames) || rawNames.some((name) => typeof name !== "string" || !name.trim())) {
    return { output: "names must be a non-empty array of tool names", isError: true };
  }
  const result = activateToolNames(
    sessionId,
    rawNames.map((name) => name.trim()),
    activatableToolNames(mcpTools),
  );
  return {
    output: JSON.stringify(result),
    isError: result.unknown.length > 0,
  };
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
  };
  const outcome = await spawnAgent(sessionId, options);
  const isError = outcome.status === "failed" || outcome.status === "timed_out";
  return {
    output: formatAgentToolResult(outcome),
    isError,
  };
}

function scheduledTasksResult(details: Record<string, unknown>, isError = false): ToolDispatchResult {
  return { output: JSON.stringify(details), isError };
}

async function runScheduledTasksTool(
  sessionId: string,
  args: Record<string, unknown>,
): Promise<ToolDispatchResult> {
  const action = typeof args.action === "string" ? args.action : "";
  if (action === "create") {
    const scheduleType = typeof args.schedule_type === "string" ? args.schedule_type : "";
    const scheduleValue = typeof args.schedule_value === "string" ? args.schedule_value.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!scheduleType || !scheduleValue || !prompt) {
      return scheduledTasksResult({
        action,
        ok: false,
        confirmed: false,
        error: "schedule_type, schedule_value, and prompt are required",
      }, true);
    }
  }

  const session = await store.getSession(sessionId);
  if (!session) return scheduledTasksResult({ action, ok: false, confirmed: false, error: "unknown session" }, true);

  if (action === "create") {
    const scheduleType = String(args.schedule_type);
    const scheduleValue = String(args.schedule_value).trim();
    const prompt = String(args.prompt).trim();
    const normalizedInput = scheduleType === "cron"
      ? `cron ${scheduleValue}`
      : scheduleType === "interval"
        ? `interval:${scheduleValue}`
        : `once: ${scheduleValue}`;
    const settings = await store.getGeneralSettingsSnapshot(session.user_id);
    const timezone = typeof args.timezone === "string" ? args.timezone : settings.timezone;
    const schedule = normalizeAgentSchedule(normalizedInput, { timezone });
    const outcome = await spawnAgent(sessionId, {
      prompt,
      description: typeof args.description === "string" && args.description.trim()
        ? args.description.trim()
        : prompt,
      subagentType: (typeof args.subagent_type === "string"
        ? args.subagent_type
        : "general-purpose") as AgentToolOptions["subagentType"],
      model: typeof args.model === "string" ? args.model : undefined,
      maxTurns: typeof args.max_turns === "number" ? args.max_turns : undefined,
      schedule: schedule.type === "cron"
        ? `cron ${schedule.value}`
        : schedule.type === "interval"
          ? `interval:${schedule.value}`
          : `once: ${schedule.value}`,
      timezone: schedule.timezone ?? undefined,
    });
    const task = await store.getScheduledTaskByIdForUser(outcome.runId, session.user_id);
    if (!task) {
      return scheduledTasksResult({
        action,
        ok: false,
        confirmed: false,
        error: "scheduled task was not persisted",
      }, true);
    }
    return scheduledTasksResult({
      action,
      ok: true,
      confirmed: true,
      id: task.id,
      task_kind: task.task_kind,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      timezone: task.timezone,
      next_run: task.next_run,
    });
  }

  if (action === "list") {
    const tasks = await store.listScheduledTasksForUser({
      userId: session.user_id,
      sessionId,
      limit: typeof args.limit === "number" ? args.limit : 50,
    });
    return scheduledTasksResult({
      action,
      ok: true,
      confirmed: true,
      count: tasks.length,
      tasks: tasks.map((task) => store.taskToApi(task)),
    });
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return scheduledTasksResult({ action, ok: false, confirmed: false, error: "id is required" }, true);
  const task = await store.getScheduledTaskByIdForUser(id, session.user_id);
  if (!task || task.session_id !== sessionId) {
    return scheduledTasksResult({ action, ok: false, confirmed: false, id, error: "scheduled task not found" }, true);
  }
  if (action === "get") {
    return scheduledTasksResult({ action, ok: true, confirmed: true, task: store.taskToApi(task) });
  }
  if (action === "pause" || action === "resume") {
    const updated = await store.updateScheduledTaskForUser(id, session.user_id, {
      status: action === "pause" ? "paused" : "active",
    });
    return scheduledTasksResult({
      action,
      ok: updated,
      confirmed: updated,
      id,
      status: action === "pause" ? "paused" : "active",
    }, !updated);
  }
  if (action === "delete") {
    const deleted = await store.deleteScheduledTaskForUser(id, session.user_id);
    return scheduledTasksResult({ action, ok: deleted, confirmed: deleted, id }, !deleted);
  }
  return scheduledTasksResult({ action, ok: false, confirmed: false, error: "unsupported action" }, true);
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
