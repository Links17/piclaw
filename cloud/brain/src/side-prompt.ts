import * as store from "@piclaw-cloud/store";
import {
  type AssistantMessage,
  type SimpleStreamOptions,
} from "./kernel/pi.ts";
import { getKernelRuntime } from "./kernel/runtime.ts";
import { resolveSessionKernelModel, resolveModelIdForLogging } from "./kernel/resolve-model.ts";
import { buildSystemPrompt } from "./llm/messages.ts";
import type { LlmUsage } from "./llm.ts";
import { config } from "./config.ts";
import { estimateProviderTokenBudget, QuotaExceededError } from "./quota.ts";

export interface SidePromptResult {
  status: "success" | "error";
  result: string | null;
  thinking: string | null;
  error?: string;
  model: string | null;
  usage?: LlmUsage;
  stopReason?: string;
  operationId?: string;
}

export function createSidePromptAbortController(requestSignal: AbortSignal): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (requestSignal.aborted) {
    cancel();
  } else {
    requestSignal.addEventListener("abort", cancel, { once: true });
  }
  return { signal: controller.signal, cancel };
}

export function makeSidePromptResult(input: {
  text: string;
  thinking: string;
  model: string;
  stopReason?: string;
  usage?: LlmUsage;
  operationId?: string;
}): SidePromptResult {
  if (!input.text.trim()) {
    return {
      status: "error",
      result: null,
      thinking: input.thinking.trim() || null,
      error: "Side prompt finished without a response.",
      model: input.model,
      stopReason: input.stopReason,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    };
  }
  return {
    status: "success",
    result: input.text,
    thinking: input.thinking.trim() || null,
    model: input.model,
    stopReason: input.stopReason,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
  };
}

function sidePromptHash(prompt: string, systemPrompt?: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${systemPrompt ?? ""}\0${prompt}`);
  return hash.digest("hex");
}

async function waitForSidePromptResult(
  sessionId: string,
  operationId: string,
): Promise<SidePromptResult | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await store.getSidePromptOperationResult(sessionId, operationId);
    if (result) return result as SidePromptResult;
    await Bun.sleep(50);
  }
  return null;
}

/** Reject before model invocation when the session owner exhausted daily tokens. */
export async function assertSidePromptQuota(sessionId: string): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session) return;
  const quota = await store.checkQuota(session.user_id, {
    maxActiveSandboxes: config.maxActiveSandboxesPerUser,
    maxDailyTokens: config.maxDailyTokensPerUser,
  });
  if (!quota.ok && quota.reason === "daily_token_limit") {
    throw new QuotaExceededError(
      "daily_tokens",
      config.maxDailyTokensPerUser,
      quota.dailyTokens ?? 0,
    );
  }
}

/**
 * Run an isolated, read-only completion against the current persisted session.
 * The response remains transient and is never added to the primary transcript.
 */
export async function runSidePrompt(
  sessionId: string,
  prompt: string,
  options: {
    systemPrompt?: string;
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onThinkingDelta?: (delta: string) => void;
    operationId?: string;
  } = {},
): Promise<SidePromptResult> {
  const operationId = options.operationId?.trim() || crypto.randomUUID();
  const kernel = getKernelRuntime();
  if (!kernel) {
    return { status: "error", result: null, thinking: null, error: "Agent kernel is not initialized.", model: null, operationId };
  }
  const session = await store.getSession(sessionId);
  if (!session) {
    return { status: "error", result: null, thinking: null, error: `unknown session ${sessionId}`, model: null, operationId };
  }
  await assertSidePromptQuota(sessionId);
  const claim = await store.claimSidePromptOperation({
    sessionId,
    operationId,
    promptHash: sidePromptHash(prompt, options.systemPrompt),
    leaseMs: 10 * 60_000,
  });
  if (claim.state === "completed") return claim.result as SidePromptResult;
  if (claim.state === "running") {
    const replay = await waitForSidePromptResult(sessionId, operationId);
    if (replay) return replay;
    return {
      status: "error",
      result: null,
      thinking: null,
      error: "Side prompt operation is still running.",
      model: null,
      operationId,
    };
  }

  const runtime = await resolveSessionKernelModel(sessionId);
  const llmContext = {
    systemPrompt: [buildSystemPrompt({
      mode: await store.getSessionMode(sessionId),
      planText: await store.getSessionPlanText(sessionId),
    }), options.systemPrompt?.trim() || ""].filter(Boolean).join("\n\n"),
    messages: [{
      role: "user" as const,
      content: [{ type: "text" as const, text: prompt }],
      timestamp: Date.now(),
    }],
  };
  const streamOptions: SimpleStreamOptions = { signal: options.signal };
  let text = "";
  let thinking = "";
  let finalMessage: AssistantMessage | null = null;
  const reservation = await store.reserveTokenBudget({
    userId: session.user_id,
    operationId: `side_prompt:${sessionId}:${operationId}`,
    estimatedTokens: estimateProviderTokenBudget({
      estimatedInputTokens: Math.ceil((prompt.length + llmContext.systemPrompt.length) / 4),
      maxOutputTokens: runtime.model.maxTokens,
      dailyLimit: config.maxDailyTokensPerUser,
    }),
    maxDailyTokens: config.maxDailyTokensPerUser,
    leaseMs: 10 * 60_000,
    ownerToken: claim.ownerToken,
  });
  if (!reservation.reserved || !reservation.reservationId) {
    throw new QuotaExceededError(
      "daily_tokens",
      config.maxDailyTokensPerUser,
      reservation.dailyTokens + reservation.reservedTokens,
    );
  }
  if (!reservation.ownerToken || !reservation.generation) {
    throw new Error(`side prompt reservation ${operationId} is owned by another executor`);
  }
  const reservationFence = {
    reservationId: reservation.reservationId,
    reservationOwnerToken: reservation.ownerToken!,
    reservationGeneration: reservation.generation!,
  };
  let sideLeaseOwned = true;
  const heartbeat = setInterval(() => {
    void store.renewSidePromptOperation({
      sessionId,
      operationId,
      ownerToken: claim.ownerToken,
      leaseMs: 10 * 60_000,
    }).then((renewed) => {
      if (!renewed) sideLeaseOwned = false;
    });
  }, 60_000);

  try {
    for await (const event of runtime.models.streamSimple(runtime.model, llmContext, streamOptions)) {
      if (event.type === "text_delta") {
        text += event.delta;
        options.onTextDelta?.(event.delta);
      } else if (event.type === "thinking_delta") {
        thinking += event.delta;
        options.onThinkingDelta?.(event.delta);
      } else if (event.type === "done") {
        finalMessage = event.message;
      } else if (event.type === "error") {
        finalMessage = event.error;
      }
    }
  } catch (error) {
    const failedUsage = finalMessage?.usage
      ? {
          inputTokens: finalMessage.usage.input,
          outputTokens: finalMessage.usage.output,
          cachedTokens: finalMessage.usage.cacheRead,
          reasoningTokens: Number((finalMessage.usage as typeof finalMessage.usage & { reasoning?: number }).reasoning ?? 0),
          cacheWriteTokens: finalMessage.usage.cacheWrite,
        }
      : undefined;
    const failed: SidePromptResult = {
      status: "error",
      result: null,
      thinking: thinking.trim() || null,
      error: error instanceof Error ? error.message : String(error),
      model: resolveModelIdForLogging(runtime.model),
      stopReason: options.signal?.aborted ? "aborted" : "error",
      operationId,
      ...(failedUsage ? { usage: failedUsage } : {}),
    };
    if (failedUsage) {
      const completionInput = {
        sessionId,
        userId: session.user_id,
        operationId,
        ownerToken: claim.ownerToken,
        result: failed,
        model: resolveModelIdForLogging(runtime.model),
        provider: runtime.providerId,
        inputTokens: failedUsage.inputTokens,
        outputTokens: failedUsage.outputTokens,
        reasoningTokens: failedUsage.reasoningTokens ?? 0,
        cacheReadTokens: failedUsage.cachedTokens,
        cacheWriteTokens: failedUsage.cacheWriteTokens ?? 0,
        status: options.signal?.aborted ? "aborted" as const : "error" as const,
        ...reservationFence,
      };
      const completed = sideLeaseOwned
        ? await store.completeSidePromptOperation(completionInput)
        : false;
      if (!completed) {
        await store.recordOrphanedSidePromptUsage(completionInput);
      }
    } else {
      await store.finishSidePromptOperation({
        sessionId,
        operationId,
        result: failed,
        ownerToken: claim.ownerToken,
      });
      await store.releaseTokenBudget({
        reservationId: reservation.reservationId,
        ownerToken: reservation.ownerToken!,
        generation: reservation.generation!,
      });
    }
    return failed;
  } finally {
    clearInterval(heartbeat);
  }

  const finalText = text || (finalMessage
    ? finalMessage.content.filter((block) => block.type === "text").map((block) => block.text).join("")
    : "");
  const finalThinking = thinking || (finalMessage
    ? finalMessage.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("")
    : "");
  const usage = finalMessage?.usage
    ? {
        inputTokens: finalMessage.usage.input,
        outputTokens: finalMessage.usage.output,
        cachedTokens: finalMessage.usage.cacheRead,
        reasoningTokens: Number((finalMessage.usage as typeof finalMessage.usage & { reasoning?: number }).reasoning ?? 0),
        cacheWriteTokens: finalMessage.usage.cacheWrite,
      }
    : undefined;
  const result = makeSidePromptResult({
    text: finalText,
    thinking: finalThinking,
    model: resolveModelIdForLogging(runtime.model),
    stopReason: finalMessage?.stopReason,
    usage,
    operationId,
  });
  if (usage) {
    const completionInput = {
      sessionId,
      userId: session.user_id,
      operationId,
      ownerToken: claim.ownerToken,
      result,
      model: resolveModelIdForLogging(runtime.model),
      provider: runtime.providerId,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      cacheReadTokens: usage.cachedTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      status: result.status === "success"
        ? "success" as const
        : finalMessage?.stopReason === "aborted"
          ? "aborted" as const
          : "error" as const,
      ...reservationFence,
    };
    const completed = sideLeaseOwned
      ? await store.completeSidePromptOperation(completionInput)
      : false;
    if (!completed) {
      await store.recordOrphanedSidePromptUsage(completionInput);
    }
  } else {
    await store.finishSidePromptOperation({
      sessionId,
      operationId,
      result,
      ownerToken: claim.ownerToken,
    });
    await store.releaseTokenBudget({
      reservationId: reservation.reservationId,
      ownerToken: reservation.ownerToken!,
      generation: reservation.generation!,
    });
  }
  return result;
}
