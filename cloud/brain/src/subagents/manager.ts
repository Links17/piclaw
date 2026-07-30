/**
 * Subagent manager — background runs, concurrency queue, result polling.
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import { notifySubagentCompletion } from "./channels.ts";
import { runExploreLoop } from "./explore-loop.ts";
import { formatCodingSubagentToolResult, runCodingSubagent } from "./gateway.ts";
import { discoverCustomAgentTypes, scheduleAgentTask } from "./custom-types.ts";
import { allocateSubagentRunId, normalizeSubagentRunId } from "./run-id.ts";
import { buildSkillPreloadSection } from "../skills/registry.ts";
import type { AgentToolOptions, SubagentRunOutcome } from "./types.ts";

const runningBySession = new Map<string, Set<string>>();

function trackRun(sessionId: string, runId: string): void {
  const set = runningBySession.get(sessionId) ?? new Set<string>();
  set.add(runId);
  runningBySession.set(sessionId, set);
}

function untrackRun(sessionId: string, runId: string): void {
  const set = runningBySession.get(sessionId);
  if (!set) return;
  set.delete(runId);
  if (set.size === 0) runningBySession.delete(sessionId);
}

async function notifyBackgroundCompletion(sessionId: string, outcome: SubagentRunOutcome): Promise<void> {
  const content = JSON.stringify({
    type: "subagent-notification",
    run_id: outcome.runId,
    status: outcome.status,
    summary: outcome.summary,
    artifacts: outcome.artifacts,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  const counter = newCounter();
  const messageId = await store.insertMessage(sessionId, "user", content, { counter });
  await store.enqueueFollowup(sessionId, { content, messageId }, counter);
  await publish(sessionId, { type: "followup_queued", content });
}

async function executeRun(sessionId: string, runId: string, options: AgentToolOptions): Promise<SubagentRunOutcome> {
  trackRun(sessionId, runId);
  await store.markSubagentRunning(runId);
  await publish(sessionId, {
    type: "subagent_started",
    runId,
    agentType: options.subagentType,
    task: options.prompt,
    description: options.description,
    replica: config.replicaId,
  });

  try {
    if (options.subagentType === "explore" || options.subagentType === "plan") {
      const loop = await runExploreLoop(sessionId, runId, options.prompt, {
        agentType: options.subagentType,
        maxTurns: options.maxTurns,
        constraints: options.description,
      });
      const outcome: SubagentRunOutcome = {
        runId,
        status: "completed",
        summary: loop.summary,
        artifacts: loop.artifacts,
        usage: {
          inputTokens: loop.usage.inputTokens ?? 0,
          outputTokens: loop.usage.outputTokens ?? 0,
        },
        background: options.runInBackground,
      };
      await store.finishSubagentRun(runId, {
        status: "completed",
        summary: outcome.summary,
        artifacts: outcome.artifacts,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      });
      await store.updateSubagentRunMeta(runId, { toolCount: loop.toolCount });
      await publish(sessionId, {
        type: "subagent_done",
        runId,
        status: "completed",
        summary: outcome.summary,
        artifacts: outcome.artifacts,
        replica: config.replicaId,
      });
      return outcome;
    }

    const coding = await runCodingSubagent(sessionId, {
      task: options.prompt,
      constraints: options.description,
      timeoutMs: options.timeoutMs,
      runId,
      agentType: options.subagentType === "general-purpose" ? "general-purpose" : "coding",
      description: options.description,
    });
    const outcome: SubagentRunOutcome = {
      runId: coding.runId,
      status: coding.status,
      summary: coding.summary,
      artifacts: coding.artifacts,
      usage: coding.usage,
      error: coding.error,
      background: options.runInBackground,
    };
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: SubagentRunOutcome = {
      runId,
      status: "failed",
      summary: "",
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      error: message,
      background: options.runInBackground,
    };
    await store.finishSubagentRun(runId, {
      status: "failed",
      summary: "",
      artifacts: [],
      error: message,
    });
    await publish(sessionId, {
      type: "subagent_done",
      runId,
      status: "failed",
      summary: "",
      artifacts: [],
      replica: config.replicaId,
    });
    return outcome;
  } finally {
    untrackRun(sessionId, runId);
    await notifySubagentCompletion(sessionId, runId);
    void drainQueuedRuns(sessionId);
  }
}

async function drainQueuedRuns(sessionId: string): Promise<void> {
  const active = await store.countActiveSubagents(sessionId);
  if (active >= config.subagentMaxConcurrent) return;
  const queued = (await store.listSubagentRuns(sessionId, 50)).filter((run) => run.status === "queued");
  for (const run of queued.slice(0, config.subagentMaxConcurrent - active)) {
    void executeRun(sessionId, run.id, {
      prompt: run.task,
      description: run.description ?? run.task,
      subagentType: (run.agent_type as AgentToolOptions["subagentType"]) ?? "general-purpose",
      maxTurns: run.max_turns ?? undefined,
      runInBackground: run.background,
    });
  }
}

export async function spawnAgent(sessionId: string, options: AgentToolOptions): Promise<SubagentRunOutcome> {
  if (options.schedule) {
    const taskId = `sched-${crypto.randomUUID()}`;
    await scheduleAgentTask(sessionId, {
      id: taskId,
      prompt: options.prompt,
      scheduleType: options.schedule.includes("cron") ? "cron" : "interval",
      scheduleValue: options.schedule,
      nextRun: new Date(Date.now() + 60_000),
    });
    return {
      runId: taskId,
      status: "queued",
      summary: `Scheduled subagent (${options.schedule})`,
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      background: true,
    };
  }

  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const customTypes = await discoverCustomAgentTypes(sessionId);
  const custom = customTypes.find((entry) => entry.name === options.subagentType);
  const skillPreload = custom?.skills?.length
    ? await buildSkillPreloadSection(session.user_id, custom.skills)
    : "";
  const resolvedOptions = custom
    ? {
        ...options,
        prompt: [custom.prompt, skillPreload, `Task:\n${options.prompt}`].filter(Boolean).join("\n\n"),
        subagentType: custom.subagentType,
        description: options.description || custom.description,
      }
    : options;

  const resumeId = normalizeSubagentRunId(resolvedOptions.resume);
  const runId = allocateSubagentRunId(resumeId);

  if (resumeId) {
    const existing = await store.getSubagentRun(resumeId);
    if (!existing) throw new Error(`unknown subagent run ${resumeId}`);
  } else {
    await store.createSubagentRun({
      id: runId,
      sessionId,
      task: resolvedOptions.prompt,
      agentType: resolvedOptions.subagentType,
      sandboxId: session.sandbox_id,
    });
    await store.updateSubagentRunMeta(runId, {
      description: resolvedOptions.description,
      maxTurns: resolvedOptions.maxTurns ?? null,
      background: resolvedOptions.runInBackground ?? false,
      resumeParentId: resumeId,
    });
    await publish(sessionId, {
      type: "subagent_created",
      runId,
      agentType: resolvedOptions.subagentType,
      description: resolvedOptions.description,
      replica: config.replicaId,
    });
  }

  const active = await store.countActiveSubagents(sessionId);
  if (active >= config.subagentMaxConcurrent) {
    await store.markSubagentQueued(runId);
    return {
      runId,
      status: "queued",
      summary: "",
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      background: resolvedOptions.runInBackground,
    };
  }

  if (resolvedOptions.runInBackground) {
    void executeRun(sessionId, runId, resolvedOptions).then(async (outcome) => {
      if (outcome.background) {
        await notifyBackgroundCompletion(sessionId, outcome);
      }
    });
    return {
      runId,
      status: "running",
      summary: "",
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      background: true,
    };
  }

  return executeRun(sessionId, runId, resolvedOptions);
}

export async function getSubagentResult(
  sessionId: string,
  agentId: string,
  options: { wait?: boolean; verbose?: boolean } = {},
): Promise<{ output: string; isError: boolean }> {
  if (options.wait) {
    await import("./channels.ts").then(({ waitForSubagentCompletion }) =>
      waitForSubagentCompletion(sessionId, agentId, config.subagentTimeoutMs),
    );
  }
  const run = await store.getSubagentRun(agentId);
  if (!run || run.session_id !== sessionId) {
    return { output: `Unknown subagent run: ${agentId}`, isError: true };
  }
  const payload = {
    run_id: run.id,
    status: run.status,
    summary: run.summary,
    artifacts: run.artifacts,
    agent_type: run.agent_type,
    ...(options.verbose
      ? {
          description: run.description,
          tool_count: run.tool_count,
          input_tokens: run.input_tokens,
          output_tokens: run.output_tokens,
          started_at: run.started_at,
          finished_at: run.finished_at,
        }
      : {}),
    ...(run.error ? { error: run.error } : {}),
  };
  const isError = !["completed", "running", "queued", "pending"].includes(run.status);
  return { output: JSON.stringify(payload, null, 2), isError };
}

export function formatAgentToolResult(outcome: SubagentRunOutcome): string {
  if (outcome.background) {
    return JSON.stringify(
      {
        run_id: outcome.runId,
        status: outcome.status,
        background: true,
        message: "Subagent started in background. Use get_subagent_result to poll.",
      },
      null,
      2,
    );
  }
  if (outcome.summary || outcome.artifacts.length > 0) {
    return JSON.stringify(
      {
        run_id: outcome.runId,
        status: outcome.status,
        summary: outcome.summary,
        artifacts: outcome.artifacts,
        usage: {
          input_tokens: outcome.usage.inputTokens,
          output_tokens: outcome.usage.outputTokens,
        },
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      null,
      2,
    );
  }
  return formatCodingSubagentToolResult({
    runId: outcome.runId,
    status: outcome.status === "stopped" ? "cancelled" : (outcome.status as "completed" | "failed" | "timed_out" | "cancelled"),
    summary: outcome.summary,
    artifacts: outcome.artifacts,
    usage: outcome.usage,
    error: outcome.error,
  });
}

export async function stopSubagent(sessionId: string, runId: string): Promise<{ ok: boolean; error?: string }> {
  const run = await store.getSubagentRun(runId);
  if (!run || run.session_id !== sessionId) return { ok: false, error: "unknown run" };
  await store.markSubagentStopped(runId, "Stopped by user.");
  await publish(sessionId, {
    type: "subagent_done",
    runId,
    status: "stopped",
    summary: "Stopped by user.",
    artifacts: [],
    replica: config.replicaId,
  });
  await notifySubagentCompletion(sessionId, runId);
  return { ok: true };
}

export async function steerSubagent(
  sessionId: string,
  runId: string,
  message: string,
): Promise<{ output: string; isError: boolean }> {
  const run = await store.getSubagentRun(runId);
  if (!run || run.session_id !== sessionId) {
    return { output: `Unknown subagent run: ${runId}`, isError: true };
  }
  if (!["running", "queued", "pending"].includes(run.status)) {
    return { output: `Subagent ${runId} is not running (status=${run.status})`, isError: true };
  }
  const { enqueueSteerMessage } = await import("./channels.ts");
  await enqueueSteerMessage(runId, message);
  await publish(sessionId, {
    type: "subagent_steered",
    runId,
    message,
    replica: config.replicaId,
  });
  return { output: `Steer message queued for ${runId}.`, isError: false };
}
