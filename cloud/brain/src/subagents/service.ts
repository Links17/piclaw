/**
 * Subagent service — unified orchestration (spawn, queue, coding worker, results).
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "../config.ts";
import { isLlmMockEnabled } from "../llm.ts";
import { publish } from "../events.ts";
import { publishWorkspaceUpdates } from "../workspace/publish.ts";
import { notifySubagentCompletion } from "./channels.ts";
import { discoverCustomAgentTypesIfNeeded, scheduleAgentTask } from "./custom-types.ts";
import { allocateSubagentRunId, normalizeSubagentRunId } from "./run-id.ts";
import { isDeferredSchedule, normalizeAgentSchedule } from "./schedule.ts";
import { buildSkillPreloadSection } from "../skills/registry.ts";
import { runSubagentLoop } from "./subagent-loop.ts";
import { runSandboxPiWorker, SandboxWorkerError } from "./sandbox-worker.ts";
import type { ProfileOverrides } from "./profiles.ts";
import type {
  AgentToolOptions,
  CodingSubagentOptions,
  CodingSubagentResult,
  SubagentRunOutcome,
} from "./types.ts";
import { TurnAbortedError } from "../turn-abort.ts";
import { realtimeKernelUsageEntry, usageEntriesForSubagentOutcome } from "./usage-ledger.ts";
import { beginOperation, beginOperationIfAccepting } from "../operations.ts";
import { QuotaExceededError } from "../quota.ts";
import { createAgentInvocation, createAgentInvocationTemplate } from "./invocation.ts";
import { resolveSubagentProfile } from "./profiles.ts";

export { usageEntriesForSubagentOutcome } from "./usage-ledger.ts";

const runningBySession = new Map<string, Set<string>>();
const runningControls = new Map<string, { controller: AbortController; done: Promise<void> }>();

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
  await publish(sessionId, { type: "followup_queued", content, messageId });
}

async function finishSubagentOutcome(
  sessionId: string,
  runId: string,
  outcome: SubagentRunOutcome,
  invocationId?: string,
  invocationFence?: { ownerToken: string; generation: number },
): Promise<SubagentRunOutcome> {
  const session = await store.getSession(sessionId);
  const expectedUsageEntries = outcome.usageEntries ?? [];
  if (session && invocationId && invocationFence) {
    await store.completeSubagentInvocation({
      sessionId,
      userId: session.user_id,
      runId,
      invocationId,
      ...invocationFence,
      status: outcome.status === "completed"
        ? "completed"
        : outcome.status === "timed_out"
          ? "timed_out"
          : outcome.status === "stopped"
            ? "stopped"
            : "failed",
      summary: outcome.summary,
      artifacts: outcome.artifacts,
      error: outcome.error ?? null,
      // Kernel provider rounds are persisted in real time. Sandbox/fallback
      // stage entries remain here because the worker cannot call Store.
      usageEntries: usageEntriesForSubagentOutcome(runId, outcome)
        .filter((usage) =>
          !usage.realtimeLedger && (usage.inputTokens > 0 || usage.outputTokens > 0)
        )
        .map((usage) => ({ ...usage, operationId: usage.invocationId })),
    });
  } else {
    await store.finishSubagentRun(runId, {
      status: outcome.status,
      summary: outcome.summary,
      artifacts: outcome.artifacts,
      error: outcome.error ?? null,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });
  }
  if (
    expectedUsageEntries.length > 0 &&
    expectedUsageEntries.every((entry) => entry.inputTokens <= 0 && entry.outputTokens <= 0) &&
    outcome.status !== "completed"
  ) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "subagent_failed_usage_unavailable",
      runId,
      status: outcome.status,
      reason: "worker/provider interface returned no failed-stage usage; no usage was fabricated",
    }));
  }
  await publish(sessionId, {
    type: "subagent_done",
    runId,
    status: outcome.status,
    summary: outcome.summary,
    artifacts: outcome.artifacts,
    replica: config.replicaId,
  });
  return outcome;
}

async function executeRun(sessionId: string, runId: string, options: AgentToolOptions): Promise<SubagentRunOutcome> {
  const operation = beginOperation("subagent");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  runningControls.set(runId, { controller, done });
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatPending: Promise<void> | null = null;
  let tracked = false;
  let invocationId: string | undefined;
  let invocationFence: { ownerToken: string; generation: number } | undefined;
  let leaseLost = false;
  try {
    invocationId = crypto.randomUUID();
    const owner = await store.getSession(sessionId);
    if (!owner) throw new Error(`unknown session ${sessionId}`);
    const claim = await store.claimSubagentInvocation({
    runId,
    sessionId,
    userId: owner.user_id,
    invocationId,
    leaseMs: Math.max(config.subagentTimeoutMs, 60_000),
  });
  if (!claim.claimed) {
    throw new Error(`subagent run ${runId} already has an active invocation`);
  }
    invocationFence = {
    ownerToken: claim.ownerToken!,
    generation: claim.generation!,
  };
    const activeInvocationId = invocationId;
    const activeInvocationFence = invocationFence;
    const reservationOperationId = `sandbox-worker:${activeInvocationId}`;
    let sandboxReservation: Awaited<ReturnType<typeof store.reserveTokenBudget>> | null = null;
    heartbeat = setInterval(() => {
      if (heartbeatPending || controller.signal.aborted) return;
      heartbeatPending = store.renewSubagentInvocation(
        activeInvocationId,
        activeInvocationFence.ownerToken,
        activeInvocationFence.generation,
        Math.max(config.subagentTimeoutMs, 60_000),
      ).then((renewed) => {
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("subagent invocation lease lost"));
        }
      }).catch((error) => {
        leaseLost = true;
        controller.abort(error);
      }).finally(() => {
        heartbeatPending = null;
      });
    }, Math.max(10_000, Math.min(60_000, Math.floor(config.subagentTimeoutMs / 3))));
    trackRun(sessionId, runId);
    tracked = true;
    await store.markSubagentRunning(runId);
    await publish(sessionId, {
    type: "subagent_started",
    runId,
    agentType: options.subagentType,
    task: options.prompt,
    description: options.description,
    replica: config.replicaId,
  });

    const profile = await resolveSubagentProfile(
      options.subagentType,
      sessionId,
      options.profileOverrides,
    );
    const invocation = createAgentInvocation({
      operationId: activeInvocationId,
      userId: owner.user_id,
      sessionId,
      agentType: options.subagentType,
      executionBackend: profile.executionBackend,
      runMode: options.runInBackground ? "background" : "foreground",
      prompt: options.prompt,
      description: options.description,
      model: options.model,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    });

    if (profile.runner === "kernel") {
      const loop = await runSubagentLoop(sessionId, runId, {
        agentType: invocation.agentType,
        prompt: invocation.prompt,
        constraints: invocation.description,
        maxTurns: invocation.maxTurns,
        profileOverrides: options.profileOverrides,
        invocationId: activeInvocationId,
        signal,
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
        usageEntries: [{
          invocationId: activeInvocationId,
          attempt: 1,
          stage: "kernel",
          provider: "cloud-kernel",
          model: config.openaiModel,
          inputTokens: loop.usage.inputTokens ?? 0,
          outputTokens: loop.usage.outputTokens ?? 0,
          reasoningTokens: loop.usage.reasoningTokens ?? 0,
          cacheReadTokens: loop.usage.cachedTokens ?? 0,
          cacheWriteTokens: loop.usage.cacheWriteTokens ?? 0,
          status: "success",
          realtimeLedger: true,
        }],
        background: options.runInBackground,
      };
      await store.updateSubagentRunMeta(runId, { toolCount: loop.toolCount });
      return finishSubagentOutcome(sessionId, runId, outcome, invocationId, invocationFence);
    }

    if (profile.runner !== "coding-worker" || invocation.executionBackend !== "sandbox") {
      throw new Error(`unsupported agent execution backend: ${invocation.executionBackend}`);
    }

    if (shouldUseSandboxWorker(invocation.prompt)) {
      sandboxReservation = await store.reserveTokenBudget({
        userId: owner.user_id,
        operationId: reservationOperationId,
        estimatedTokens: Math.max(1, Math.floor(config.maxDailyTokensPerUser * 0.1)),
        maxDailyTokens: config.maxDailyTokensPerUser,
        leaseMs: Math.max(config.subagentTimeoutMs, 60_000),
        ownerToken: activeInvocationFence.ownerToken,
      });
      if (
        !sandboxReservation.reserved
        || !sandboxReservation.reservationId
        || !sandboxReservation.ownerToken
        || !sandboxReservation.generation
      ) {
        throw new QuotaExceededError(
          "daily_tokens",
          config.maxDailyTokensPerUser,
          sandboxReservation.dailyTokens + sandboxReservation.reservedTokens,
        );
      }
    }
    let coding: CodingSubagentResult;
    try {
      coding = await runCodingSubagent(sessionId, {
        task: invocation.prompt,
        constraints: invocation.description,
        timeoutMs: invocation.timeoutMs,
        runId,
        agentType: options.subagentType === "general-purpose" ? "general-purpose" : "coding",
        description: options.description,
        skipLifecycleEvents: true,
        invocationId: activeInvocationId,
        signal,
      });
    } catch (error) {
      if (!(error instanceof SandboxWorkerError)) throw error;
      coding = {
        runId,
        status: error.status,
        summary: error.status === "stopped" ? "Stopped by user." : "",
        artifacts: [],
        usage: error.usage,
        usageEntries: error.receipts.map((receipt) => ({
          invocationId: activeInvocationId,
          attempt: receipt.attempt,
          stage: "sandbox_worker",
          provider: "openai",
          model: config.openaiModel,
          inputTokens: receipt.inputTokens,
          outputTokens: receipt.outputTokens,
          reasoningTokens: receipt.reasoningTokens,
          cacheReadTokens: receipt.cacheReadTokens,
          cacheWriteTokens: receipt.cacheWriteTokens,
          status: error.status,
        })),
        error: error.message,
      };
    }
    const outcome: SubagentRunOutcome = {
      runId: coding.runId,
      status: coding.status,
      summary: coding.summary,
      artifacts: coding.artifacts,
      usage: coding.usage,
      usageEntries: coding.usageEntries?.map((entry) => ({ ...entry, invocationId: activeInvocationId })),
      error: coding.error,
      background: options.runInBackground,
    };
    const completed = await finishSubagentOutcome(
      sessionId,
      runId,
      outcome,
      invocationId,
      invocationFence,
    );
    if (
      sandboxReservation?.reservationId
      && sandboxReservation.ownerToken
      && sandboxReservation.generation
    ) {
      if (coding.usage.inputTokens > 0 || coding.usage.outputTokens > 0) {
        await store.settleTokenBudget({
          reservationId: sandboxReservation.reservationId,
          ownerToken: sandboxReservation.ownerToken,
          generation: sandboxReservation.generation,
          actualInputTokens: coding.usage.inputTokens,
          actualOutputTokens: coding.usage.outputTokens,
        });
      } else {
        await store.releaseTokenBudget({
          reservationId: sandboxReservation.reservationId,
          ownerToken: sandboxReservation.ownerToken,
          generation: sandboxReservation.generation,
        });
      }
    }
    return completed;
  } catch (error) {
    if (!invocationId || !invocationFence) throw error;
    if (leaseLost) {
      throw new Error(`subagent invocation lease lost for ${runId}`);
    }
    if (error instanceof TurnAbortedError || signal.aborted) {
      const outcome: SubagentRunOutcome = {
        runId,
        status: "stopped",
        summary: "Stopped by user.",
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        background: options.runInBackground,
      };
      return finishSubagentOutcome(sessionId, runId, outcome, invocationId, invocationFence);
    }
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
    return finishSubagentOutcome(sessionId, runId, outcome, invocationId, invocationFence);
  } finally {
    operation.finish();
    if (heartbeat) clearInterval(heartbeat);
    const pendingRenewal = heartbeatPending as Promise<void> | null;
    await pendingRenewal?.catch(() => {});
    if (tracked) untrackRun(sessionId, runId);
    runningControls.delete(runId);
    resolveDone();
    if (leaseLost) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "subagent_invocation_lease_lost",
        sessionId,
        runId,
      }));
    } else if (tracked) {
      await notifySubagentCompletion(sessionId, runId);
      void drainQueuedRuns(sessionId).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          event: "subagent_queue_drain_failed",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }
  }
}

async function drainQueuedRuns(sessionId: string): Promise<void> {
  const admission = beginOperationIfAccepting("subagent_queue_drain");
  if (!admission.accepted) return;
  try {
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
    }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "subagent_background_failed",
        sessionId,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }
  } finally {
    admission.operation.finish();
  }
}

export async function spawnAgent(sessionId: string, options: AgentToolOptions): Promise<SubagentRunOutcome> {
  const deferredSchedule = options.schedule?.trim() ?? "";
  if (isDeferredSchedule(deferredSchedule)) {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const generalSettings = await store.getGeneralSettingsSnapshot(session.user_id);
    const customTypes = await discoverCustomAgentTypesIfNeeded(sessionId, options.subagentType);
    const custom = customTypes.find((entry) => entry.name === options.subagentType);
    const effectiveAgentType = custom?.subagentType ?? options.subagentType;
    const profile = await resolveSubagentProfile(effectiveAgentType, sessionId, custom
      ? {
          promptMode: custom.promptMode,
          maxTurns: custom.maxTurns ?? options.maxTurns,
          toolNames: custom.tools,
        }
      : options.profileOverrides);
    const schedule = normalizeAgentSchedule(deferredSchedule, {
      timezone: options.timezone ?? generalSettings.timezone,
    });
    const scheduledPrompt = custom
      ? [
          custom.prompt,
          custom.skills?.length ? await buildSkillPreloadSection(session.user_id, custom.skills) : "",
          `Task:\n${options.prompt}`,
        ].filter(Boolean).join("\n\n")
      : options.prompt;
    const invocation = createAgentInvocationTemplate({
      agentType: effectiveAgentType,
      executionBackend: profile.executionBackend,
      prompt: scheduledPrompt,
      description: custom?.description || options.description,
      model: custom?.model || options.model,
      maxTurns: custom?.maxTurns ?? options.maxTurns,
      timeoutMs: options.timeoutMs,
      profileOverrides: custom
        ? {
            promptMode: custom.promptMode,
            maxTurns: custom.maxTurns,
            toolNames: custom.tools,
          }
        : options.profileOverrides,
    });
    const taskId = `sched-${crypto.randomUUID()}`;
    await scheduleAgentTask(sessionId, {
      id: taskId,
      prompt: scheduledPrompt,
      scheduleType: schedule.type,
      scheduleValue: schedule.value,
      timezone: schedule.timezone,
      nextRun: new Date(schedule.nextRun),
      invocation,
    });
    return {
      runId: taskId,
      status: "queued",
      summary: `Scheduled agent ${taskId} (${schedule.type})`,
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      background: true,
    };
  }

  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const customTypes = await discoverCustomAgentTypesIfNeeded(sessionId, options.subagentType);
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
        profileOverrides: {
          promptMode: custom.promptMode,
          maxTurns: custom.maxTurns ?? options.maxTurns,
          toolNames: custom.tools,
        } satisfies ProfileOverrides,
      }
    : options;

  const resumeId = normalizeSubagentRunId(resolvedOptions.resume);
  const runId = allocateSubagentRunId(resumeId);

  if (resumeId) {
    const existing = await store.getSubagentRunForUser(resumeId, session.user_id);
    if (!existing || existing.session_id !== sessionId) {
      throw new Error(`subagent run access denied`);
    }
  } else {
    const run = {
      id: runId,
      sessionId,
      task: resolvedOptions.prompt,
      agentType: resolvedOptions.subagentType,
      sandboxId: session.sandbox_id,
    };
    if (
      resolvedOptions.requireImmediateStart
      && !(await store.createSubagentRunIfCapacity({
        ...run,
        maxActive: config.subagentMaxConcurrent,
      }))
    ) {
      return {
        runId,
        status: "queued",
        summary: "Subagent capacity unavailable",
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "subagent capacity unavailable",
        background: false,
      };
    }
    if (!resolvedOptions.requireImmediateStart) {
      await store.createSubagentRun(run);
    }
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
  if (!resolvedOptions.requireImmediateStart && active >= config.subagentMaxConcurrent) {
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
    }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "subagent_background_failed",
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
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
  const control = runningControls.get(runId);
  control?.controller.abort(new TurnAbortedError("Stopped by user."));
  if (control) await control.done;
  else await store.markSubagentStopped(runId, "Stopped by user.");
  return { ok: true };
}

export async function stopAllRunningSubagents(sessionId: string): Promise<void> {
  const runIds = [...(runningBySession.get(sessionId) ?? [])];
  for (const runId of runIds) {
    await stopSubagent(sessionId, runId);
  }
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

function resolveWorkerMode(task: string): "mock" | "brain" | "sandbox" {
  if (task.startsWith("mock-coding:")) {
    if (isLlmMockEnabled()) return "mock";
    throw new Error("mock-coding: prefix requires CLOUD_LLM_MOCK=1 on the brain process");
  }
  if (config.codingWorkerMode === "mock") {
    if (isLlmMockEnabled()) return "mock";
    throw new Error("subagent.codingWorkerMode=mock requires CLOUD_LLM_MOCK=1 on the brain process");
  }
  if (config.codingWorkerMode === "brain") return "brain";
  if (config.codingWorkerMode === "sandbox") return "sandbox";
  if (!config.sandboxEnabled || !config.openaiApiKey || !config.openaiBaseUrl) {
    throw new Error(
      "Coding worker unavailable: configure openai and sandbox in brain.config.json, or set CLOUD_LLM_MOCK=1 for mock-coding tests",
    );
  }
  return "sandbox";
}

export function shouldUseSandboxWorker(task: string): boolean {
  return resolveWorkerMode(task) === "sandbox";
}

async function runSandboxWorkerWithFallback(
  sessionId: string,
  runId: string,
  options: CodingSubagentOptions,
  timeoutMs: number,
  invocationId?: string,
  signal?: AbortSignal,
): Promise<CodingSubagentResult> {
  let workerError: string | undefined;
  let workerUsage: CodingSubagentResult["usage"] | undefined;
  let workerStatus: "failed" | "timed_out" | "stopped" = "failed";
  let workerEntries: NonNullable<CodingSubagentResult["usageEntries"]> = [];
  try {
    const workerOutcome = await runSandboxPiWorker(sessionId, runId, {
      task: options.task,
      constraints: options.constraints,
      timeoutMs,
      openaiBaseUrl: config.openaiBaseUrl,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel,
      signal,
    });
    workerOutcome.runId = runId;
    if (workerOutcome.status === "completed") {
      return workerOutcome;
    }
    workerUsage = workerOutcome.usage;
    workerEntries = workerOutcome.usageEntries ?? [];
    workerStatus = workerOutcome.status === "timed_out"
      ? "timed_out"
      : workerOutcome.status === "stopped" || workerOutcome.status === "cancelled"
        ? "stopped"
        : "failed";
    workerError = workerOutcome.error;
  } catch (error) {
    workerError = error instanceof Error ? error.message : String(error);
    if (error instanceof SandboxWorkerError) {
      workerUsage = error.usage;
      workerStatus = error.status;
      workerEntries = error.receipts.map((receipt) => ({
        invocationId: runId,
        attempt: receipt.attempt,
        stage: "sandbox_worker",
        provider: "openai",
        model: config.openaiModel,
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
        reasoningTokens: receipt.reasoningTokens,
        cacheReadTokens: receipt.cacheReadTokens,
        cacheWriteTokens: receipt.cacheWriteTokens,
        status: error.status,
      }));
    }
  }

  const loop = await runSubagentLoop(sessionId, runId, {
    agentType: "general-purpose",
    prompt: options.task,
    constraints: options.constraints,
    invocationId,
    signal,
  });
  return {
    runId,
    status: "completed",
    summary: loop.summary,
    artifacts: loop.artifacts,
    usage: {
      inputTokens: (workerUsage?.inputTokens ?? 0) + (loop.usage.inputTokens ?? 0),
      outputTokens: (workerUsage?.outputTokens ?? 0) + (loop.usage.outputTokens ?? 0),
    },
    usageEntries: [
      ...workerEntries.map((entry) => ({ ...entry, invocationId: runId, status: workerStatus })),
      {
        invocationId: runId,
        attempt: workerEntries.length + 1,
        stage: "fallback",
        provider: "cloud-kernel",
        model: config.openaiModel,
        inputTokens: loop.usage.inputTokens ?? 0,
        outputTokens: loop.usage.outputTokens ?? 0,
        reasoningTokens: loop.usage.reasoningTokens ?? 0,
        cacheReadTokens: loop.usage.cachedTokens ?? 0,
        cacheWriteTokens: loop.usage.cacheWriteTokens ?? 0,
        status: "success",
        realtimeLedger: Boolean(invocationId),
      },
    ],
    ...(workerError ? { error: `sandbox worker fallback: ${workerError}` } : {}),
  };
}

export async function runCodingSubagent(
  sessionId: string,
  options: CodingSubagentOptions & {
    runId?: string;
    agentType?: string;
    description?: string;
    skipLifecycleEvents?: boolean;
    invocationId?: string;
    signal?: AbortSignal;
  },
): Promise<CodingSubagentResult> {
  const parentRunId = normalizeSubagentRunId(options.runId);
  const runId = allocateSubagentRunId(parentRunId);
  const timeoutMs = options.timeoutMs ?? config.subagentTimeoutMs;
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`unknown session ${sessionId}`);
  }

  if (!parentRunId) {
    await store.createSubagentRun({
      id: runId,
      sessionId,
      task: options.task,
      sandboxId: session.sandbox_id,
      agentType: options.agentType ?? "coding",
    });
    if (options.description) {
      await store.updateSubagentRunMeta(runId, { description: options.description });
    }
  }

  if (!options.skipLifecycleEvents) {
    await publish(sessionId, {
      type: "subagent_started",
      runId,
      agentType: "coding",
      task: options.task,
      replica: config.replicaId,
    });
    await store.markSubagentRunning(runId, session.sandbox_id);
  }

  const mode = resolveWorkerMode(options.task);
  let outcome: CodingSubagentResult;

  try {
    if (mode === "sandbox") {
      outcome = await runSandboxWorkerWithFallback(
        sessionId,
        runId,
        options,
        timeoutMs,
        options.invocationId,
        options.signal,
      );
    } else {
      const task =
        mode === "mock" && !options.task.startsWith("mock-coding:")
          ? `mock-coding:${options.task}`
          : options.task;
      const loop = await runSubagentLoop(sessionId, runId, {
        agentType: "general-purpose",
        prompt: task,
        constraints: options.constraints,
        invocationId: options.invocationId,
        signal: options.signal,
      });
      outcome = {
        runId,
        status: "completed",
        summary: loop.summary,
        artifacts: loop.artifacts,
        usage: {
          inputTokens: loop.usage.inputTokens ?? 0,
          outputTokens: loop.usage.outputTokens ?? 0,
        },
        usageEntries: [{
          invocationId: runId,
          attempt: 1,
          stage: "kernel",
          provider: "cloud-kernel",
          model: config.openaiModel,
          inputTokens: loop.usage.inputTokens ?? 0,
          outputTokens: loop.usage.outputTokens ?? 0,
          reasoningTokens: loop.usage.reasoningTokens ?? 0,
          cacheReadTokens: loop.usage.cachedTokens ?? 0,
          cacheWriteTokens: loop.usage.cacheWriteTokens ?? 0,
          status: "success",
          realtimeLedger: Boolean(options.invocationId),
        }],
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "sandbox") {
      try {
        const loop = await runSubagentLoop(sessionId, runId, {
          agentType: "general-purpose",
          prompt: options.task,
          constraints: options.constraints,
          invocationId: options.invocationId,
          signal: options.signal,
        });
        outcome = {
          runId,
          status: "completed",
          summary: loop.summary,
          artifacts: loop.artifacts,
          usage: {
            inputTokens: loop.usage.inputTokens ?? 0,
            outputTokens: loop.usage.outputTokens ?? 0,
          },
          usageEntries: options.invocationId
            ? [realtimeKernelUsageEntry(options.invocationId, loop.usage, config.openaiModel)]
            : undefined,
          error: `sandbox worker fallback: ${message}`,
        };
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        outcome = {
          runId,
          status: message.includes("timeout") ? "timed_out" : "failed",
          summary: "",
          artifacts: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          error: `${message}; fallback: ${fallbackMessage}`,
        };
      }
    } else {
      outcome = {
        runId,
        status: message.includes("timeout") ? "timed_out" : "failed",
        summary: "",
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        error: message,
      };
    }
  }

  if (!options.skipLifecycleEvents) {
    await store.finishSubagentRun(runId, {
      status: outcome.status,
      summary: outcome.summary,
      artifacts: outcome.artifacts,
      error: outcome.error ?? null,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });

    await publish(sessionId, {
      type: "subagent_done",
      runId,
      status: outcome.status,
      summary: outcome.summary,
      artifacts: outcome.artifacts,
      replica: config.replicaId,
    });
  }

  if (outcome.status === "completed" && outcome.artifacts.length > 0) {
    await publishWorkspaceUpdates(sessionId, outcome.artifacts);
  }

  return outcome;
}

export function formatCodingSubagentToolResult(result: CodingSubagentResult): string {
  return JSON.stringify(
    {
      run_id: result.runId,
      status: result.status,
      summary: result.summary,
      artifacts: result.artifacts,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      },
      ...(result.error ? { error: result.error } : {}),
    },
    null,
    2,
  );
}
