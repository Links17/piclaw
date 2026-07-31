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
import { dispatchTool, getDispatchMcpTools } from "./tools/dispatcher.ts";
import { getToolDefinitionsForMode, type ToolDefinition } from "./tools/schemas.ts";
import { QuotaExceededError } from "./quota.ts";
import { trackTurnDelta, trackTurnFinished, trackTurnStarted, setPlanPreview } from "./agent-run-state.ts";
import { answerPendingQuestionForSession, interruptPendingQuestion, publishQuestionCleared } from "./tools/question.ts";
import { getPendingQuestion } from "./question/state.ts";
import { buildSkillsPromptSection } from "./skills/registry.ts";
import { scheduleSessionTitleGeneration } from "./session-title.ts";
import { stopAllRunningSubagents } from "./subagents/manager.ts";
import {
  TurnAbortedError,
  assertTurnNotAborted,
  beginTurnAbortScope,
  clearTurnAbortScope,
  getTurnAbortSignal,
  isTurnAborted,
  signalTurnAbort,
  throwIfAborted,
} from "./turn-abort.ts";

export type TurnOutcome = "ran" | "queued" | "answered" | "aborted";

export interface SubmitMessageResult {
  outcome: TurnOutcome;
  userMessageId: number;
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
    await publish(sessionId, { type: "followup_queued", content: messageContent });
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

async function buildTurnContext(sessionId: string): Promise<{
  mode: "plan" | "execute";
  tools: ToolDefinition[];
  skillsSection: string;
  planText: string;
}> {
  const session = await store.getSession(sessionId);
  const userId = session?.user_id ?? "default-user";
  const [mode, planText, skillsSection, mcpTools] = await Promise.all([
    store.getSessionMode(sessionId),
    store.getSessionPlanText(sessionId),
    buildSkillsPromptSection(sessionId, userId),
    getDispatchMcpTools(),
  ]);
  return {
    mode,
    planText,
    skillsSection,
    tools: getToolDefinitionsForMode(mode, mcpTools),
  };
}

async function runToolLoop(
  sessionId: string,
  counter: ReturnType<typeof newCounter>,
  onDelta: (text: string) => Promise<void>,
  options: { recovery?: boolean } = {},
): Promise<{ finalText: string; usage: LlmUsage; assistantMessageId: number | null }> {
  const turnContext = await buildTurnContext(sessionId);
  let messages: OpenAiMessage[] = historyToOpenAi(await store.hydrate(sessionId, counter), {
    mode: turnContext.mode,
    skillsSection: turnContext.skillsSection,
    planText: turnContext.planText,
  });
  let totalUsage: LlmUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let finalText = "";
  let assistantMessageId: number | null = null;
  let questionCallsThisTurn = 0;

  for (let round = 0; round < config.maxToolRounds; round += 1) {
    assertTurnNotAborted(sessionId);
    const result = await streamCompletionRound(
      messages,
      onDelta,
      turnContext.tools,
      { sessionId, signal: getTurnAbortSignal(sessionId) },
    );
    totalUsage = mergeUsage(totalUsage, result.usage);

    if (result.toolCalls.length === 0) {
      finalText = result.text;
      assistantMessageId = await store.insertMessage(sessionId, "assistant", finalText, {
        counter,
        recoveryMarker: options.recovery ?? false,
      });
      messages.push({ role: "assistant", content: finalText });
      if (turnContext.mode === "plan" && finalText.trim()) {
        await store.setSessionPlanText(sessionId, finalText.trim());
        setPlanPreview(sessionId, finalText.trim());
        await publish(sessionId, { type: "plan_update", text: finalText.trim(), replica: config.replicaId });
      }
      break;
    }

    const toolCalls = toOpenAiToolCalls(result.toolCalls);
    await store.insertMessage(sessionId, "assistant", result.text || "", {
      counter,
      contentBlocks: assistantToolCallBlocks(toolCalls),
    });
    messages.push({ role: "assistant", content: result.text || null, tool_calls: toolCalls });

    for (const call of result.toolCalls) {
      assertTurnNotAborted(sessionId);
      let args: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        parseError = `Invalid tool arguments JSON for ${call.name}`;
      }
      const skillDetail =
        call.name === "skill" && typeof args.name === "string" ? String(args.name) : undefined;

      await publish(sessionId, {
        type: "tool_start",
        name: call.name,
        toolCallId: call.id,
        replica: config.replicaId,
        ...(skillDetail ? { detail: skillDetail } : {}),
      });

      let toolResult: { output: string; isError: boolean };
      if (parseError) {
        toolResult = { output: parseError, isError: true };
      } else if (call.name === "question") {
        if (questionCallsThisTurn >= 1) {
          toolResult = {
            output: "question tool already used this turn; proceed with reasonable defaults.",
            isError: true,
          };
        } else {
          questionCallsThisTurn += 1;
          toolResult = await dispatchTool(sessionId, call.name, args, turnContext.mode, turnContext.tools);
        }
      } else {
        toolResult = await dispatchTool(sessionId, call.name, args, turnContext.mode, turnContext.tools);
      }

      if (isTurnAborted(sessionId)) {
        throw new TurnAbortedError();
      }

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
  trackTurnStarted(sessionId, messageId);
  await publish(sessionId, { type: "turn_started", messageId, replica: config.replicaId });
  beginTurnAbortScope(sessionId);

  try {
    const { finalText, usage, assistantMessageId } = await runToolLoop(
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

export async function setSessionMode(sessionId: string, mode: "plan" | "execute"): Promise<void> {
  await store.setSessionMode(sessionId, mode);
}
