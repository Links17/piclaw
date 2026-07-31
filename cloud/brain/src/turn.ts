/**
 * Turn executor — advisory lock, hydrate, LLM tool loop, follow-up drain.
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "./config.ts";
import { publish } from "./events.ts";
import { runKernelToolLoop } from "./kernel/loop.ts";
import { getKernelRuntime } from "./kernel/runtime.ts";
import { QuotaExceededError } from "./quota.ts";
import { trackTurnDelta, trackTurnFinished, trackTurnStarted, getInflightTurn } from "./agent-run-state.ts";
import { answerPendingQuestionForSession, interruptPendingQuestion, publishQuestionCleared } from "./tools/question.ts";
import { getPendingQuestion } from "./question/state.ts";
import { scheduleSessionTitleGeneration } from "./session-title.ts";
import { stopAllRunningSubagents } from "./subagents/service.ts";
import { enqueueSessionSteerMessage } from "./subagents/channels.ts";
import { sendAgentReplyWebPush } from "./push/service.ts";
import {
  TurnAbortedError,
  beginTurnAbortScope,
  clearTurnAbortScope,
  signalTurnAbort,
} from "./turn-abort.ts";

export type TurnOutcome = "ran" | "queued" | "answered" | "aborted";

export interface SubmitMessageResult {
  outcome: TurnOutcome;
  userMessageId: number;
}

export interface QueueMutationResult {
  removed: boolean;
  row_id?: number;
  count: number;
}

function normalizeIncomingContent(content: string): { content: string; modeSwitch?: "plan" | "execute" } {
  const trimmed = content.trim();
  if (trimmed.startsWith("/plan")) {
    return { content: trimmed.slice(5).trim() || "Enter plan mode.", modeSwitch: "plan" };
  }
  if (trimmed.startsWith("/execute")) {
    return { content: trimmed.slice(8).trim() || "Execute the approved plan.", modeSwitch: "execute" };
  }
  return { content };
}

function isAbortCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === "/abort" || trimmed.startsWith("/abort ");
}

export async function abortSessionTurn(sessionId: string): Promise<{ ok: boolean; aborted: boolean }> {
  const hadPendingQuestion = Boolean(getPendingQuestion(sessionId));
  signalTurnAbort(sessionId);
  if (hadPendingQuestion) {
    await interruptPendingQuestion(sessionId);
  } else {
    await publishQuestionCleared(sessionId);
  }
  await stopAllRunningSubagents(sessionId);
  trackTurnFinished(sessionId);
  const cursor = await store.getCursor(sessionId);
  const inflightId = cursor?.inflight_message_id == null ? undefined : Number(cursor.inflight_message_id);
  await publish(sessionId, {
    type: "turn_aborted",
    ...(inflightId != null && Number.isFinite(inflightId) ? { messageId: inflightId } : {}),
    replica: config.replicaId,
  });
  return { ok: true, aborted: true };
}

export async function submitMessage(sessionId: string, content: string): Promise<SubmitMessageResult> {
  if (isAbortCommand(content)) {
    await abortSessionTurn(sessionId);
    return { outcome: "aborted", userMessageId: 0 };
  }

  const pendingQuestion = getPendingQuestion(sessionId);
  if (pendingQuestion) {
    const answerResult = await answerPendingQuestionForSession(sessionId, content);
    if (answerResult.ok) {
      return { outcome: "answered", userMessageId: 0 };
    }
  }

  const normalized = normalizeIncomingContent(content);
  if (normalized.modeSwitch) {
    await store.setSessionMode(sessionId, normalized.modeSwitch);
  }
  const messageContent = normalized.content;

  await store.touchSessionActivity(sessionId);
  const session = await store.getSession(sessionId);
  if (session) {
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

  const lock = await store.tryLockSession(sessionId);
  if (!lock) {
    const counter = newCounter();
    const messageId = await store.insertMessage(sessionId, "user", messageContent, { counter });
    const userMessageCount = await store.countUserMessages(sessionId);
    if (userMessageCount === 1 && session?.user_id) {
      scheduleSessionTitleGeneration(sessionId, session.user_id, messageContent);
    }
    await store.enqueueFollowup(sessionId, { content: messageContent, messageId }, counter);
    await publish(sessionId, { type: "followup_queued", content: messageContent, messageId });
    await publish(sessionId, { type: "message", id: messageId, role: "user", content: messageContent });
    const retryLock = await store.tryLockSession(sessionId);
    if (retryLock) {
      try {
        await drainFollowups(sessionId);
      } finally {
        await retryLock.release();
      }
    }
    return { outcome: "queued", userMessageId: messageId };
  }

  let userMessageId = 0;
  try {
    const counter = newCounter();
    userMessageId = await store.insertMessage(sessionId, "user", messageContent, { counter });
    const userMessageCount = await store.countUserMessages(sessionId);
    if (userMessageCount === 1 && session?.user_id) {
      scheduleSessionTitleGeneration(sessionId, session.user_id, messageContent);
    }
    await publish(sessionId, { type: "message", id: userMessageId, role: "user", content: messageContent });
    await runTurnLocked(sessionId, userMessageId, counter);
    await drainFollowups(sessionId);
  } finally {
    await lock.release();
  }
  return { outcome: "ran", userMessageId };
}

async function runTurnLocked(
  sessionId: string,
  messageId: number,
  counter: ReturnType<typeof newCounter>,
  options: { recovery?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  await store.beginTurn(sessionId, messageId, counter);
  trackTurnStarted(sessionId, messageId);
  await publish(sessionId, { type: "turn_started", messageId, replica: config.replicaId });
  beginTurnAbortScope(sessionId);

  try {
    if (!getKernelRuntime()) {
      throw new Error(
        "Agent kernel is not initialized — configure openai in brain.config.json or set CLOUD_LLM_MOCK=1",
      );
    }
    const { finalText, usage, assistantMessageId } = await runKernelToolLoop(
      sessionId,
      counter,
      async (delta) => {
        trackTurnDelta(sessionId, delta);
        await publish(sessionId, { type: "delta", text: delta, replica: config.replicaId });
      },
      { recovery: options.recovery ?? false },
    );

    if (assistantMessageId == null) {
      throw new Error("turn completed without assistant message");
    }

    await store.endTurn(sessionId, messageId, counter);
    const durationMs = Date.now() - startedAt;
    await store.logTokenUsage({
      sessionId,
      messageId: assistantMessageId,
      model: config.openaiModel,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cachedTokens ?? 0,
      durationMs,
    });
    const owner = await store.getSession(sessionId);
    if (owner) {
      await store.incrementDailyTokenUsage(
        owner.user_id,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
      );
    }
    await publish(sessionId, {
      type: "message",
      id: assistantMessageId,
      role: "assistant",
      content: finalText,
      recovery: options.recovery ?? false,
    });
    await publish(sessionId, {
      type: "turn_done",
      messageId,
      replica: config.replicaId,
      dbRoundtrips: counter.count,
      durationMs,
    });
    trackTurnFinished(sessionId);
    void sendAgentReplyWebPush({ chatJid: sessionId, body: finalText }).catch((error) => {
      console.warn(`[${config.replicaId}] web push failed for ${sessionId}:`, error);
    });
  } catch (error) {
    if (error instanceof TurnAbortedError) {
      await store.endTurn(sessionId, messageId, counter);
      trackTurnFinished(sessionId);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await store.endTurnWithError(sessionId, messageId, message, counter);
    trackTurnFinished(sessionId);
    await publish(sessionId, { type: "turn_failed", messageId, error: message, replica: config.replicaId });
    throw error;
  } finally {
    clearTurnAbortScope(sessionId);
  }
}

async function drainFollowups(sessionId: string): Promise<void> {
  while (true) {
    const counter = newCounter();
    const item = await store.popFollowup(sessionId, counter);
    if (item === null) return;
    await publish(sessionId, { type: "followup_consumed", content: item.content, messageId: item.messageId });
    await runTurnLocked(sessionId, item.messageId, counter);
  }
}

export async function sweepInflight(): Promise<void> {
  const stale = await store.getStaleInflight(config.inflightGraceMs);
  for (const row of stale) {
    const lock = await store.tryLockSession(row.session_id);
    if (!lock) continue;

    try {
      const cursor = await store.getCursor(row.session_id);
      const inflightId = cursor?.inflight_message_id == null ? null : Number(cursor.inflight_message_id);
      if (inflightId === null) continue;

      if (await store.hasAssistantReplyAfter(row.session_id, inflightId)) {
        await store.clearInflight(row.session_id);
        continue;
      }

      const startedAt = new Date(String(cursor?.inflight_started_at)).getTime();
      if (Date.now() - startedAt > config.maxInflightAgeMs) {
        await store.clearInflight(row.session_id);
        await publish(row.session_id, {
          type: "recovery",
          messageId: inflightId,
          action: "cleared",
          replica: config.replicaId,
        });
        continue;
      }

      await publish(row.session_id, {
        type: "recovery",
        messageId: inflightId,
        action: "retried",
        replica: config.replicaId,
      });
      const counter = newCounter();
      await runTurnLocked(row.session_id, inflightId, counter, { recovery: true });
      await drainFollowups(row.session_id);
    } catch (error) {
      console.error(`[${config.replicaId}] recovery for ${row.session_id} failed:`, error);
    } finally {
      await lock.release();
    }
  }
}

export async function setSessionMode(sessionId: string, mode: "plan" | "execute"): Promise<void> {
  await store.setSessionMode(sessionId, mode);
}

export async function removeQueuedFollowup(sessionId: string, rowId: number): Promise<QueueMutationResult> {
  const counter = newCounter();
  const removed = await store.removeFollowupByMessageId(sessionId, rowId, counter);
  if (!removed) {
    const items = await store.listQueuedFollowupItems(sessionId);
    return { removed: false, count: items.length };
  }
  await store.deleteMessage(sessionId, rowId, counter);
  await publish(sessionId, { type: "followup_removed", messageId: rowId });
  const items = await store.listQueuedFollowupItems(sessionId);
  return { removed: true, row_id: rowId, count: items.length };
}

export async function steerQueuedFollowup(
  sessionId: string,
  rowId: number,
): Promise<QueueMutationResult & { queued?: "steer" | false; user_message?: { id: number; content: string } }> {
  const counter = newCounter();
  const removed = await store.removeFollowupByMessageId(sessionId, rowId, counter);
  if (!removed) {
    const items = await store.listQueuedFollowupItems(sessionId);
    return { removed: false, count: items.length };
  }
  await publish(sessionId, { type: "followup_removed", messageId: rowId });
  const inflight = getInflightTurn(sessionId);
  if (inflight) {
    await enqueueSessionSteerMessage(sessionId, removed.content);
    await publish(sessionId, { type: "steer_applied", content: removed.content, replica: config.replicaId });
    const items = await store.listQueuedFollowupItems(sessionId);
    return {
      removed: true,
      row_id: rowId,
      queued: "steer",
      count: items.length,
      user_message: { id: rowId, content: removed.content },
    };
  }
  const lock = await store.tryLockSession(sessionId);
  if (!lock) {
    await store.enqueueFollowup(sessionId, removed, counter);
    await publish(sessionId, { type: "followup_queued", content: removed.content, messageId: rowId });
    const items = await store.listQueuedFollowupItems(sessionId);
    return { removed: false, row_id: rowId, count: items.length };
  }
  try {
    await runTurnLocked(sessionId, rowId, counter);
    await drainFollowups(sessionId);
  } finally {
    await lock.release();
  }
  const items = await store.listQueuedFollowupItems(sessionId);
  return {
    removed: true,
    row_id: rowId,
    queued: false,
    count: items.length,
    user_message: { id: rowId, content: removed.content },
  };
}

export async function reorderQueuedFollowups(
  sessionId: string,
  fromIndex: number,
  toIndex: number,
): Promise<{ reordered: boolean; count: number }> {
  const counter = newCounter();
  const reordered = await store.reorderFollowups(sessionId, fromIndex, toIndex, counter);
  const items = await store.listQueuedFollowupItems(sessionId);
  return { reordered, count: items.length };
}
