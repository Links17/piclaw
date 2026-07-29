/**
 * Subagent gateway — blocking coding_agent execution with PG state tracking.
 */
import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import { runBrainCodingLoop } from "./coding-loop.ts";
import { runSandboxPiWorker } from "./sandbox-worker.ts";
import type { CodingSubagentOptions, CodingSubagentResult } from "./types.ts";

function resolveWorkerMode(task: string): "mock" | "brain" | "sandbox" {
  if (config.codingWorkerMode === "mock" || task.startsWith("mock-coding:")) {
    return "mock";
  }
  if (config.codingWorkerMode === "brain") return "brain";
  if (config.codingWorkerMode === "sandbox") return "sandbox";
  if (!config.sandboxEnabled || !config.openaiApiKey || !config.openaiBaseUrl) {
    return "mock";
  }
  return "sandbox";
}

async function runSandboxWorkerWithFallback(
  sessionId: string,
  runId: string,
  options: CodingSubagentOptions,
  timeoutMs: number,
): Promise<CodingSubagentResult> {
  let workerError: string | undefined;
  try {
    const workerOutcome = await runSandboxPiWorker(sessionId, runId, {
      task: options.task,
      constraints: options.constraints,
      timeoutMs,
      openaiBaseUrl: config.openaiBaseUrl,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel,
    });
    workerOutcome.runId = runId;
    if (workerOutcome.status === "completed") {
      return workerOutcome;
    }
    workerError = workerOutcome.error;
  } catch (error) {
    workerError = error instanceof Error ? error.message : String(error);
  }

  const loop = await runBrainCodingLoop(sessionId, runId, options.task, options.constraints);
  return {
    runId,
    status: "completed",
    summary: loop.summary,
    artifacts: loop.artifacts,
    usage: {
      inputTokens: loop.usage.inputTokens ?? 0,
      outputTokens: loop.usage.outputTokens ?? 0,
    },
    ...(workerError ? { error: `sandbox worker fallback: ${workerError}` } : {}),
  };
}

export async function runCodingSubagent(
  sessionId: string,
  options: CodingSubagentOptions,
): Promise<CodingSubagentResult> {
  const runId = `run-${crypto.randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? config.subagentTimeoutMs;
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`unknown session ${sessionId}`);
  }

  await store.createSubagentRun({
    id: runId,
    sessionId,
    task: options.task,
    sandboxId: session.sandbox_id,
  });

  await publish(sessionId, {
    type: "subagent_started",
    runId,
    agentType: "coding",
    task: options.task,
    replica: config.replicaId,
  });

  await store.markSubagentRunning(runId, session.sandbox_id);

  const mode = resolveWorkerMode(options.task);
  let outcome: CodingSubagentResult;

  try {
    if (mode === "mock" || mode === "brain") {
      const loop = await runBrainCodingLoop(
        sessionId,
        runId,
        options.task.startsWith("mock-coding:") ? options.task : `mock-coding:${options.task}`,
        options.constraints,
      );
      outcome = {
        runId,
        status: "completed",
        summary: loop.summary,
        artifacts: loop.artifacts,
        usage: {
          inputTokens: loop.usage.inputTokens ?? 0,
          outputTokens: loop.usage.outputTokens ?? 0,
        },
      };
    } else {
      outcome = await runSandboxWorkerWithFallback(sessionId, runId, options, timeoutMs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "sandbox") {
      try {
        const loop = await runBrainCodingLoop(sessionId, runId, options.task, options.constraints);
        outcome = {
          runId,
          status: "completed",
          summary: loop.summary,
          artifacts: loop.artifacts,
          usage: {
            inputTokens: loop.usage.inputTokens ?? 0,
            outputTokens: loop.usage.outputTokens ?? 0,
          },
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
