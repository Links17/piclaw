/**
 * Turn executor — the heart of PoC 1.
 *
 * Flow per turn (design doc §6.1):
 *   advisory lock → beginTurn → hydrate → LLM stream (deltas to Redis)
 *   → insert final message → endTurn → drain queued follow-ups → unlock
 *
 * Mutual exclusion is the PG advisory lock; when we lose the race the
 * message is appended to the deferred follow-up queue instead (the current
 * lock holder drains it before releasing).
 */
import { config } from "./config.ts";
import { newCounter } from "./db.ts";
import { publish } from "./events.ts";
import { streamCompletion } from "./llm.ts";
import * as store from "./store.ts";

export type TurnOutcome = "ran" | "queued";

/**
 * Handle one submitted user message: run the turn if the session lane is
 * free, otherwise defer it as a follow-up.
 */
export async function submitMessage(sessionId: string, content: string): Promise<TurnOutcome> {
  const lock = await store.tryLockSession(sessionId);
  if (!lock) {
    const counter = newCounter();
    const messageId = await store.insertMessage(sessionId, "user", content, { counter });
    await store.enqueueFollowup(sessionId, { content, messageId }, counter);
    await publish(sessionId, { type: "followup_queued", content });
    // Close a race window: the lock holder may have finished its drain just
    // before our enqueue landed. If the lane is free now, drain ourselves.
    const retryLock = await store.tryLockSession(sessionId);
    if (retryLock) {
      try {
        await drainFollowups(sessionId);
      } finally {
        await retryLock.release();
      }
    }
    return "queued";
  }

  try {
    const counter = newCounter();
    const messageId = await store.insertMessage(sessionId, "user", content, { counter });
    await runTurnLocked(sessionId, messageId, counter);
    await drainFollowups(sessionId);
  } finally {
    await lock.release();
  }
  return "ran";
}

/** Run one turn; caller must hold the session lock. */
async function runTurnLocked(
  sessionId: string,
  messageId: number,
  counter: ReturnType<typeof newCounter>,
  options: { recovery?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  await store.beginTurn(sessionId, messageId, counter);
  await publish(sessionId, { type: "turn_started", messageId, replica: config.replicaId });

  try {
    const history = await store.hydrate(sessionId, counter);
    const result = await streamCompletion(history, async (delta) => {
      await publish(sessionId, { type: "delta", text: delta, replica: config.replicaId });
    });

    const assistantId = await store.insertMessage(sessionId, "assistant", result.text, {
      recoveryMarker: options.recovery ?? false,
      counter,
    });
    await store.endTurn(sessionId, messageId, counter);

    const durationMs = Date.now() - startedAt;
    await store.logTurnUsage({
      sessionId,
      inputTokens: result.usage.inputTokens,
      cachedTokens: result.usage.cachedTokens,
      outputTokens: result.usage.outputTokens,
      dbRoundtrips: counter.count,
      durationMs,
    });
    await publish(sessionId, {
      type: "message",
      id: assistantId,
      role: "assistant",
      content: result.text,
      recovery: options.recovery ?? false,
    });
    await publish(sessionId, {
      type: "turn_done",
      messageId,
      replica: config.replicaId,
      dbRoundtrips: counter.count,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.endTurnWithError(sessionId, messageId, message, counter);
    await publish(sessionId, { type: "turn_failed", messageId, error: message, replica: config.replicaId });
    throw error;
  }
}

/**
 * Drain deferred follow-ups FIFO while holding the lock. The queued item
 * references the user message inserted at submission time, so nothing is
 * inserted twice.
 */
async function drainFollowups(sessionId: string): Promise<void> {
  while (true) {
    const counter = newCounter();
    const item = await store.popFollowup(sessionId, counter);
    if (item === null) return;
    await publish(sessionId, { type: "followup_consumed", content: item.content });
    await runTurnLocked(sessionId, item.messageId, counter);
  }
}

// ── inflight recovery sweep (multi-replica recoverInflightRuns) ────────

/**
 * Periodic sweep: find inflight rows old enough that their replica may have
 * died, and try to take over. Taking the advisory lock is the liveness
 * check — if the original replica still runs the turn, the lock is held and
 * we skip. Mirrors runtime recoverInflightRuns():
 *   - terminal reply already exists → clear the marker
 *   - marker too old               → clear without retry
 *   - otherwise                    → re-run the turn with a recovery marker
 */
export async function sweepInflight(): Promise<void> {
  const stale = await store.getStaleInflight(config.inflightGraceMs);
  for (const row of stale) {
    const lock = await store.tryLockSession(row.session_id);
    if (!lock) continue; // still running on a live replica

    try {
      // Re-check under the lock: the original replica may have finished
      // between our scan and lock acquisition.
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
