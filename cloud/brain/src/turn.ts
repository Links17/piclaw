/**
 * Turn executor — advisory lock, hydrate, LLM tool loop, follow-up drain.
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "./config.ts";
import { publish } from "./events.ts";
import { streamCompletionRound, type LlmUsage } from "./llm.ts";
import {
  assistantToolCallBlocks,
  historyToOpenAi,
  toolResultBlocks,
  type OpenAiMessage,
  type OpenAiToolCall,
} from "./llm/messages.ts";
import { dispatchTool } from "./tools/dispatcher.ts";
import { QuotaExceededError } from "./quota.ts";

export type TurnOutcome = "ran" | "queued";

export async function submitMessage(sessionId: string, content: string): Promise<TurnOutcome> {
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

function mergeUsage(total: LlmUsage, round: LlmUsage): LlmUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (round.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (round.outputTokens ?? 0),
    cachedTokens: (total.cachedTokens ?? 0) + (round.cachedTokens ?? 0),
  };
}

function toOpenAiToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): OpenAiToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
}

async function runToolLoop(
  sessionId: string,
  counter: ReturnType<typeof newCounter>,
  onDelta: (text: string) => Promise<void>,
  options: { recovery?: boolean } = {},
): Promise<{ finalText: string; usage: LlmUsage; assistantMessageId: number | null }> {
  let messages: OpenAiMessage[] = historyToOpenAi(await store.hydrate(sessionId, counter));
  let totalUsage: LlmUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let finalText = "";
  let assistantMessageId: number | null = null;

  for (let round = 0; round < config.maxToolRounds; round += 1) {
    const result = await streamCompletionRound(messages, onDelta);
    totalUsage = mergeUsage(totalUsage, result.usage);

    if (result.toolCalls.length === 0) {
      finalText = result.text;
      assistantMessageId = await store.insertMessage(sessionId, "assistant", finalText, {
        counter,
        recoveryMarker: options.recovery ?? false,
      });
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    const toolCalls = toOpenAiToolCalls(result.toolCalls);
    await store.insertMessage(sessionId, "assistant", result.text || "", {
      counter,
      contentBlocks: assistantToolCallBlocks(toolCalls),
    });
    messages.push({ role: "assistant", content: result.text || null, tool_calls: toolCalls });

    for (const call of result.toolCalls) {
      await publish(sessionId, {
        type: "tool_start",
        name: call.name,
        toolCallId: call.id,
        replica: config.replicaId,
      });

      let args: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        parseError = `Invalid tool arguments JSON for ${call.name}`;
      }

      const toolResult = parseError
        ? { output: parseError, isError: true }
        : await dispatchTool(sessionId, call.name, args);

      await publish(sessionId, {
        type: "tool_result",
        name: call.name,
        toolCallId: call.id,
        isError: toolResult.isError,
        replica: config.replicaId,
      });

      await store.insertMessage(sessionId, "tool", toolResult.output, {
        counter,
        contentBlocks: toolResultBlocks(call.id, call.name),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult.output });
    }

    if (round === config.maxToolRounds - 1) {
      finalText = result.text || "Stopped: maximum tool rounds reached.";
      assistantMessageId = await store.insertMessage(sessionId, "assistant", finalText, {
        counter,
        recoveryMarker: options.recovery ?? false,
      });
    }
  }

  return { finalText, usage: totalUsage, assistantMessageId };
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
    const { finalText, usage, assistantMessageId } = await runToolLoop(
      sessionId,
      counter,
      async (delta) => {
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
