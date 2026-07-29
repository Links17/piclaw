/**
 * Turn executor — advisory lock lane, hydrate, LLM stream, sandbox bash, follow-up drain.
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "./config.ts";
import { publish } from "./events.ts";
import { streamCompletion } from "./llm.ts";
import { runBash } from "./sandbox/session.ts";

export type TurnOutcome = "ran" | "queued";

export async function submitMessage(sessionId: string, content: string): Promise<TurnOutcome> {
  const lock = await store.tryLockSession(sessionId);
  if (!lock) {
    const counter = newCounter();
    const messageId = await store.insertMessage(sessionId, "user", content, { counter });
    await store.enqueueFollowup(sessionId, { content, messageId }, counter);
    await publish(sessionId, { type: "followup_queued", content });
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

async function maybeSandboxPrefix(sessionId: string, history: store.MessageRow[]): Promise<string> {
  const last = [...history].reverse().find((m) => m.role === "user");
  const content = last?.content ?? "";
  if (!content.startsWith("bash:")) return "";
  const command = content.slice(5).trim();
  if (!command) return "";
  try {
    return await runBash(sessionId, command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[sandbox error] ${message}`;
  }
}

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
    const sandboxPrefix = await maybeSandboxPrefix(sessionId, history);
    const result = await streamCompletion(
      history,
      async (delta) => {
        await publish(sessionId, { type: "delta", text: delta, replica: config.replicaId });
      },
      { prefix: sandboxPrefix ? `${sandboxPrefix}\n\n` : "" },
    );

    const assistantId = await store.insertMessage(sessionId, "assistant", result.text, {
      recoveryMarker: options.recovery ?? false,
      counter,
    });
    await store.endTurn(sessionId, messageId, counter);

    const durationMs = Date.now() - startedAt;
    await store.logTokenUsage({
      sessionId,
      messageId: assistantId,
      model: config.openaiModel,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cacheReadTokens: result.usage.cachedTokens ?? 0,
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

async function drainFollowups(sessionId: string): Promise<void> {
  while (true) {
    const counter = newCounter();
    const item = await store.popFollowup(sessionId, counter);
    if (item === null) return;
    await publish(sessionId, { type: "followup_consumed", content: item.content });
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
