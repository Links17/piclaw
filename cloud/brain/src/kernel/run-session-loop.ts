import * as store from "@piclaw-cloud/store";
import type { RoundtripCounter } from "@piclaw-cloud/store/db";
import {
  convertToLlm,
  estimateContextTokens,
  runAgentLoopContinue,
  shouldCompact,
  type AgentContext,
  type AgentEvent,
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type Usage,
  type Model,
} from "./pi.ts";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import type { LlmUsage } from "../llm.ts";
import type { ToolDefinition } from "../tools/schemas.ts";
import { setPlanPreview, setContextUsage } from "../agent-run-state.ts";
import {
  TurnAbortedError,
  assertTurnNotAborted,
  getTurnAbortSignal,
  isTurnAborted,
} from "../turn-abort.ts";
import {
  assistantMessageToRow,
  extractAssistantText,
  rowsToAgentMessages,
  toolResultMessageToRow,
} from "./message-map.ts";
import {
  assistantMessageToSubagentBlocks,
} from "./subagent-message-map.ts";
import { getKernelRuntime } from "./runtime.ts";
import { buildAgentTools } from "./tool-bridge.ts";
import { getSessionCompactionSettings } from "./compaction-settings.ts";
import { estimateProviderTokenBudget, QuotaExceededError } from "../quota.ts";
import { getActiveToolNames } from "../tools/active.ts";
import { getAllToolDefinitions, getToolDefinitionsForMode } from "../tools/schemas.ts";
import type { MessageRow } from "@piclaw-cloud/store";
import {
  buildCompactionWindow,
  compactionSummaryToAgentMessage,
  expandCompactionWindow,
  validateCompactionSummary,
  type PersistedCompactionSummary,
} from "./smart-compaction.ts";

const DEFAULT_GRACE_TURNS = 5;
const WRAP_UP_MESSAGE =
  "Wrap up now — provide your final summary in the next response without more tools.";
const MAX_COMPACTION_SUMMARY_CHARS = 24_000;
const MAX_TOOL_CALL_ARGUMENT_CHARS = 4_000;
const APPROXIMATE_CHARS_PER_TOKEN = 4;

export class ContextOverflowError extends Error {
  readonly code = "context_overflow";
  readonly estimatedTokens: number;
  readonly budgetTokens: number;

  constructor(estimatedTokens: number, budgetTokens: number) {
    super(`context overflow: estimated ${estimatedTokens} tokens exceeds budget ${budgetTokens}`);
    this.name = "ContextOverflowError";
    this.estimatedTokens = estimatedTokens;
    this.budgetTokens = budgetTokens;
  }
}

export interface CompactionRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function publishCommittedCompaction(options: {
  publishDone: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<void> {
  try {
    await options.publishDone();
  } catch (error) {
    options.warn(error instanceof Error ? error.message : String(error));
  }
}

export function buildIncrementalCompactionMessages(
  agentMessages: AgentMessage[],
  retainedMessageCount: number,
): { messages: AgentMessage[]; previousSummary?: string } {
  const previous = agentMessages.find((message) => message.role === "compactionSummary");
  const summarizeCount = Math.max(0, agentMessages.length - retainedMessageCount);
  return {
    messages: agentMessages
      .slice(0, summarizeCount)
      .filter((message) => message.role !== "compactionSummary"),
    previousSummary: previous?.role === "compactionSummary" ? previous.summary : undefined,
  };
}

export async function selectValidatedCompactionPair<W, S>(options: {
  initialWindow: W;
  maxAttempts: number;
  providerBudget: number;
  generate: (window: W) => Promise<S>;
  candidateTokens: (window: W, summary: S) => Promise<number> | number;
  expand: (window: W) => W | null;
}): Promise<{ window: W; summary: S; candidateTokens: number } | null> {
  let window = options.initialWindow;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const summary = await options.generate(window);
    const candidateTokens = await options.candidateTokens(window, summary);
    if (candidateTokens <= options.providerBudget) {
      return { window, summary, candidateTokens };
    }
    if (attempt === options.maxAttempts - 1) return null;
    const expanded = options.expand(window);
    if (!expanded) return null;
    window = expanded;
  }
  return null;
}

function boundedJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return serialized;
  const marker = `… ${serialized.length - maxChars} argument characters omitted …`;
  const available = Math.max(0, maxChars - marker.length);
  return `${serialized.slice(0, available)}${marker}`;
}

export function serializeCompactionMessages(messages: AgentMessage[]): string {
  return messages.map((message) => {
    if (message.role === "user") {
      return `USER:\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`;
    }
    if (message.role === "assistant") {
      const text = extractAssistantText(message);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((call) =>
          `TOOL_CALL id=${call.id} name=${call.name} arguments=${boundedJson(call.arguments, MAX_TOOL_CALL_ARGUMENT_CHARS)}`
        );
      return [`ASSISTANT:\n${text}`, ...calls].filter(Boolean).join("\n");
    }
    if (message.role === "toolResult") {
      const content = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return `TOOL_RESULT call_id=${message.toolCallId} name=${message.toolName} error=${message.isError}:\n${content}`;
    }
    if (message.role === "compactionSummary") return `PREVIOUS SUMMARY:\n${message.summary}`;
    return "";
  }).filter(Boolean).join("\n\n");
}

export async function generateCompactionSummary(options: {
  messages: AgentMessage[];
  previousSummary?: string;
  model: Model<string>;
  models: NonNullable<ReturnType<typeof getKernelRuntime>>["models"];
  apiKey: string;
  maxTokens: number;
  maxChars: number;
  timeoutSec: number;
  signal?: AbortSignal;
  onAttemptUsage?: (receipt: {
    attempt: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    status: "success" | "failed" | "aborted" | "error";
  }) => Promise<void>;
}): Promise<{ text: string; usage: CompactionRunUsage }> {
  const serialized = serializeCompactionMessages(options.messages);
  const prompt = `Create a concise durable context summary. Preserve exact user constraints, decisions, file paths, errors, progress, and next steps. Do not continue the conversation.
Use Markdown headings. Include at least two durable sections such as ## Goal, ## Constraints, ## Decisions, ## Progress, or ## Next Steps.
Keep the summary under ${options.maxChars} characters.

${options.previousSummary ? `Existing summary to merge:\n${options.previousSummary}\n\n` : ""}Conversation:
${serialized}`;
  const runAttempt = async (repairReason?: string): Promise<AssistantMessage> => {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("compaction summary timed out")),
      Math.max(1, options.timeoutSec) * 1_000,
    );
    const linkedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    let final: AssistantMessage | null = null;
    try {
      for await (const event of options.models.streamSimple(options.model, {
        systemPrompt: "You summarize agent conversations for future turns. Return only the summary.",
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: repairReason
              ? `${prompt}\n\nRepair requirement: the previous attempt failed validation (${repairReason}). Return one complete structured summary only.`
              : prompt,
          }],
          timestamp: Date.now(),
        }],
      }, {
        apiKey: options.apiKey,
        signal: linkedSignal,
        maxTokens: options.maxTokens,
        cacheRetention: "none",
      })) {
        if (event.type === "done") final = event.message;
        if (event.type === "error") final = event.error;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!final) throw new Error("compaction summary completion failed");
    return final;
  };

  let lastReason = "compaction summary validation failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const final = await runAttempt(attempt === 0 ? undefined : lastReason);
    const text = extractAssistantText(final).trim();
    const validation = validateCompactionSummary({
      text,
      stopReason: final.stopReason,
      maxChars: options.maxChars,
    });
    if (validation.valid) {
      await options.onAttemptUsage?.({
        attempt: attempt + 1,
        provider: final.provider,
        model: final.model,
        inputTokens: final.usage.input,
        outputTokens: final.usage.output,
        reasoningTokens: Number((final.usage as Usage & { reasoning?: number }).reasoning ?? 0),
        cacheReadTokens: final.usage.cacheRead,
        cacheWriteTokens: final.usage.cacheWrite,
        status: "success",
      });
      return {
        text,
        usage: {
          inputTokens: final.usage.input,
          outputTokens: final.usage.output,
          cacheReadTokens: final.usage.cacheRead,
          cacheWriteTokens: final.usage.cacheWrite,
        },
      };
    }
    await options.onAttemptUsage?.({
      attempt: attempt + 1,
      provider: final.provider,
      model: final.model,
      inputTokens: final.usage.input,
      outputTokens: final.usage.output,
      reasoningTokens: Number((final.usage as Usage & { reasoning?: number }).reasoning ?? 0),
      cacheReadTokens: final.usage.cacheRead,
      cacheWriteTokens: final.usage.cacheWrite,
      status: final.stopReason === "aborted" ? "aborted" : "failed",
    });
    lastReason = validation.reason;
    if (final.stopReason === "aborted" || options.signal?.aborted) break;
  }
  throw new Error(lastReason);
}

async function maybeCompactMessages(
  agentMessages: AgentMessage[],
  sessionId: string,
  sessionModel: Model<string>,
  userId: string,
  kernel: NonNullable<ReturnType<typeof getKernelRuntime>>,
  sourceRows: MessageRow[] | undefined,
  apiKey: string,
  expectedInflightMessageId: number | undefined,
): Promise<AgentMessage[]> {
  const compaction = await getSessionCompactionSettings(userId, sessionModel.contextWindow);
  if (!compaction.enabled) return agentMessages;
  const backoff = await store.getCompactionBackoff(sessionId);
  if (backoff?.retryAfter && Date.parse(backoff.retryAfter) > Date.now()) return agentMessages;

  const estimate = estimateContextTokens(agentMessages);
  const thresholdReached = shouldCompact(estimate.tokens, sessionModel.contextWindow, compaction.settings);
  if (!thresholdReached) {
    return agentMessages;
  }
  const previous = await store.getLatestCompaction(sessionId);
  const estimatedSummaryBudget = Math.min(
    sessionModel.maxTokens,
    Math.max(512, Math.floor(compaction.settings.reserveTokens * 0.8)),
  );
  const estimatedSummaryTokens = Math.max(
    estimatedSummaryBudget,
    previous?.summary
      ? estimateContextTokens([compactionSummaryToAgentMessage(previous)]).tokens
      : 0,
  );
  let window = sourceRows
    ? buildCompactionWindow(sourceRows, {
        contextWindow: sessionModel.contextWindow,
        reserveTokens: compaction.settings.reserveTokens,
        estimatedSummaryTokens,
        estimateRowTokens: (row) => Math.max(
          1,
          Math.ceil(
            (row.content.length + JSON.stringify(row.content_blocks ?? "").length)
              / APPROXIMATE_CHARS_PER_TOKEN,
          ),
        ),
        afterMessageId: previous?.compactedThroughMessageId,
      })
    : null;
  console.log(JSON.stringify({
    level: "info",
    event: "compaction_evaluated",
    replicaId: config.replicaId,
    sessionId,
    contextTokens: estimate.tokens,
    contextWindow: sessionModel.contextWindow,
    sourceRows: sourceRows?.length ?? 0,
    hasWindow: Boolean(window),
  }));
  if (!window) return agentMessages;
  if (window.overflow) {
    throw new ContextOverflowError(
      window.overflow.currentTurnTokens,
      window.overflow.budgetTokens,
    );
  }
  let activeWindow = window;
  const settings = await store.getCompactionSettingsSnapshot(userId);
  const sourceMappingOptions = {
    toolResultMaxChars: settings.toolResultCompactionEnabled
      ? settings.toolResultSemanticSummaryMaxInputChars
      : undefined,
    toolResultCompactionTools: settings.toolResultCompactionTools,
  };
  const previousSummary = agentMessages.find((message) => message.role === "compactionSummary");
  try {
    const providerBudget = Math.max(
      0,
      sessionModel.contextWindow - compaction.settings.reserveTokens,
    );
    const pair = await selectValidatedCompactionPair({
      initialWindow: activeWindow,
      maxAttempts: 4,
      providerBudget,
      generate: async (candidateWindow) => {
        const messagesToSummarize = rowsToAgentMessages(
          candidateWindow.rowsToSummarize,
          sessionModel.id,
          sourceMappingOptions,
        );
        if (messagesToSummarize.length === 0) {
          throw new ContextOverflowError(estimate.tokens, providerBudget);
        }
        activeWindow = candidateWindow;
        return generateCompactionSummary({
          messages: messagesToSummarize,
          previousSummary: previousSummary?.role === "compactionSummary"
            ? previousSummary.summary
            : previous?.summary,
          model: sessionModel,
          models: kernel.models,
          apiKey,
          maxTokens: estimatedSummaryBudget,
          maxChars: MAX_COMPACTION_SUMMARY_CHARS,
          timeoutSec: settings.compactionTimeoutSec,
          signal: getTurnAbortSignal(sessionId),
          onAttemptUsage: async (receipt) => {
            const operationId = `compaction:${candidateWindow.compactedThroughMessageId}`;
            const attempt = await store.allocateTokenAttempt({
              sessionId,
              source: "compaction",
              operationId,
              stage: "summary",
            });
            await store.logTokenUsage({
              usageKey:
                `compaction:${sessionId}:${candidateWindow.compactedThroughMessageId}:${attempt}`,
              sessionId,
              userId,
              source: "compaction",
              operationId,
              attempt,
              stage: "summary",
              provider: receipt.provider,
              model: receipt.model,
              inputTokens: receipt.inputTokens,
              outputTokens: receipt.outputTokens,
              reasoningTokens: receipt.reasoningTokens,
              cacheReadTokens: receipt.cacheReadTokens,
              cacheWriteTokens: receipt.cacheWriteTokens,
              status: receipt.status === "error" ? "error" : receipt.status,
            });
          },
        });
      },
      candidateTokens: (candidateWindow, candidateSummary) => {
        assertTurnNotAborted(sessionId);
        const retained = rowsToAgentMessages(
          candidateWindow.retainedRows,
          sessionModel.id,
          sourceMappingOptions,
        );
        if (retained.length === 0) return Number.POSITIVE_INFINITY;
        const persistedCandidate: PersistedCompactionSummary = {
          id: -1,
          sessionId,
          compactedThroughMessageId: candidateWindow.compactedThroughMessageId,
          summary: candidateSummary.text.trim(),
          tokensBefore: estimate.tokens,
          createdAt: new Date().toISOString(),
        };
        return estimateContextTokens([
          compactionSummaryToAgentMessage(persistedCandidate),
          ...retained,
        ]).tokens;
      },
      expand: expandCompactionWindow,
    });
    if (!pair) throw new ContextOverflowError(estimate.tokens, providerBudget);
    const validatedWindow = pair.window;
    const summaryResult = pair.summary;
    const retainedMessages = rowsToAgentMessages(
      validatedWindow.retainedRows,
      sessionModel.id,
      sourceMappingOptions,
    );
    if (expectedInflightMessageId == null) return agentMessages;
    const recorded = await store.commitCompaction({
      sessionId,
      userId,
      expectedInflightMessageId,
      compactedThroughMessageId: validatedWindow.compactedThroughMessageId,
      summary: summaryResult.text.trim(),
      tokensBefore: estimate.tokens,
      model: sessionModel.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    if (!recorded.compaction) return agentMessages;
    if (recorded.created) {
      // The DB transaction is the compaction commit point. SSE is best-effort:
      // a publish failure must not rewrite the durable ledger, and a later main
      // turn abort does not invalidate the completed summary LLM operation.
      await publishCommittedCompaction({
        publishDone: () => publish(sessionId, {
          type: "compaction_done",
          compactedThroughMessageId: validatedWindow.compactedThroughMessageId,
          tokensBefore: estimate.tokens,
          replica: config.replicaId,
        }),
        warn: (reason) => console.warn(JSON.stringify({
          level: "warn",
          event: "compaction_publish_failed",
          replicaId: config.replicaId,
          sessionId,
          compactedThroughMessageId: validatedWindow.compactedThroughMessageId,
          reason,
        })),
      });
    }
    const persisted: PersistedCompactionSummary = recorded.compaction;
    const compactedMessages = [
      compactionSummaryToAgentMessage(persisted),
      ...retainedMessages,
    ];
    const compactedEstimate = estimateContextTokens(compactedMessages).tokens;
    if (compactedEstimate > providerBudget) {
      throw new ContextOverflowError(compactedEstimate, providerBudget);
    }
    return compactedMessages;
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "compaction_failed",
      replicaId: config.replicaId,
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (!isTurnAborted(sessionId) && !(error instanceof ContextOverflowError)) {
      await store.recordCompactionFailure(
        sessionId,
        error instanceof Error ? error.message : String(error),
        settings.compactionBackoffBaseMin,
        settings.compactionBackoffMaxMin,
      );
    }
    if (error instanceof ContextOverflowError) throw error;
    return agentMessages;
  }
}

export type SessionPersistTarget =
  | {
      kind: "session";
      sessionId: string;
      counter: RoundtripCounter;
      recovery?: boolean;
      userMessageId: number;
      operationId: string;
    }
  | { kind: "subagent"; sessionId: string; runId: string; invocationId?: string };

export interface RunAgentSessionLoopOptions {
  persist: SessionPersistTarget;
  messages: AgentMessage[];
  systemPrompt: string;
  mode: "plan" | "execute";
  toolDefinitions: ToolDefinition[];
  strictToolDefinitions?: boolean;
  model?: Model<string>;
  models?: NonNullable<ReturnType<typeof getKernelRuntime>>["models"];
  apiKey?: string;
  userId?: string;
  sourceRows?: MessageRow[];
  sourceBoundaryMessageId?: number;
  maxTurns: number;
  graceTurns?: number;
  onDelta?: (text: string) => Promise<void>;
  pollSteer?: () => Promise<string | null>;
  onSteerApplied?: (message: string) => Promise<void>;
  onPlanUpdate?: (text: string) => Promise<void>;
  limitQuestionPerTurn?: boolean;
  signal?: AbortSignal;
}

export interface SessionLoopResult {
  finalText: string;
  usage: LlmUsage;
  assistantMessageId: number | null;
  toolCount: number;
}

async function updateMainContextUsage(input: {
  sessionId: string;
  userId: string;
  tokens: number;
  contextWindow: number;
  model: string;
  provider: string;
  throughMessageId: number;
  latestMessageId: number;
  compactedThroughMessageId: number;
}): Promise<void> {
  const snapshot = {
    tokens: input.tokens,
    contextWindow: input.contextWindow,
    percent: Math.min(100, Math.round((input.tokens / input.contextWindow) * 100)),
    model: input.model,
    provider: input.provider,
    throughMessageId: input.throughMessageId,
    latestMessageId: input.latestMessageId,
    compactedThroughMessageId: input.compactedThroughMessageId,
    updatedAt: new Date().toISOString(),
  };
  setContextUsage(input.sessionId, snapshot);
  const persisted = await store.upsertSessionContextSnapshot({
    sessionId: input.sessionId,
    userId: input.userId,
    usedTokens: input.tokens,
    contextWindow: input.contextWindow,
    model: input.model,
    provider: input.provider,
    throughMessageId: input.throughMessageId,
    latestMessageId: input.latestMessageId,
    compactedThroughMessageId: input.compactedThroughMessageId,
  });
  if (persisted) {
    setContextUsage(input.sessionId, {
      ...snapshot,
      updatedAt: persisted.updatedAt,
    });
  }
}

async function refreshMainContextUsageFromMessages(input: {
  sessionId: string;
  userId: string;
  messages: AgentMessage[];
  contextWindow: number;
  model: string;
  provider: string;
  throughMessageId: number;
  latestMessageId: number;
  compactedThroughMessageId: number;
}): Promise<void> {
  await updateMainContextUsage({
    ...input,
    tokens: estimateContextTokens(input.messages).tokens,
  });
}

export function resolveSessionLoopToolDefinitions(
  sessionId: string,
  mode: "plan" | "execute",
  toolDefinitions: ToolDefinition[],
  strict = false,
): ToolDefinition[] {
  if (strict) return toolDefinitions;
  const mcpTools = toolDefinitions.filter((tool) => tool.function.name.startsWith("mcp__"));
  return getToolDefinitionsForMode(mode, mcpTools, getActiveToolNames(sessionId));
}

function usageToLlm(usage: Usage): LlmUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedTokens: usage.cacheRead,
    reasoningTokens: Number((usage as Usage & { reasoning?: number }).reasoning ?? 0),
    cacheWriteTokens: usage.cacheWrite,
  };
}

function mergeUsage(total: LlmUsage, round: LlmUsage): LlmUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (round.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (round.outputTokens ?? 0),
    cachedTokens: (total.cachedTokens ?? 0) + (round.cachedTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (round.reasoningTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (round.cacheWriteTokens ?? 0),
  };
}

async function persistSessionMessage(
  target: Extract<SessionPersistTarget, { kind: "session" }>,
  message: AssistantMessage | ToolResultMessage,
  attempt: number,
): Promise<number | null> {
  if (message.role === "assistant") {
    const row = assistantMessageToRow(message, {
      userMessageId: target.userMessageId,
      operationId: target.operationId,
      attempt,
    });
    return store.insertMessage(target.sessionId, "assistant", row.content, {
      counter: target.counter,
      contentBlocks: row.contentBlocks ?? null,
      recoveryMarker: target.recovery ?? false,
    });
  }
  const row = toolResultMessageToRow(message, {
    userMessageId: target.userMessageId,
    operationId: target.operationId,
  });
  await store.insertMessage(target.sessionId, "tool", row.content, {
    counter: target.counter,
    contentBlocks: row.contentBlocks,
  });
  return null;
}

async function persistSubagentMessage(
  runId: string,
  message: AssistantMessage | ToolResultMessage,
): Promise<void> {
  if (message.role === "assistant") {
    const row = assistantMessageToSubagentBlocks(message);
    await store.insertSubagentMessage(runId, "assistant", row.content);
    return;
  }
  const row = toolResultMessageToRow(message);
  await store.insertSubagentMessage(runId, "tool", row.content, {
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  });
}

export async function runAgentSessionLoop(
  options: RunAgentSessionLoopOptions,
): Promise<SessionLoopResult> {
  const kernel = getKernelRuntime();
  if (!kernel) {
    throw new Error("Agent kernel is not initialized");
  }

  const persist = options.persist;
  const sessionId = persist.sessionId;
  const sessionModel = options.model ?? kernel.model;
  const sessionModels = options.models ?? kernel.models;
  const sessionApiKey = options.apiKey ?? config.openaiApiKey;
  const sessionOwner = await store.getSession(sessionId);
  const userId = options.userId ?? sessionOwner?.user_id ?? "default-user";
  const compactionConfig = await getSessionCompactionSettings(userId, sessionModel.contextWindow);

  const isSubagent = persist.kind === "subagent";
  const runId = isSubagent ? persist.runId : undefined;
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;
  const hardStopTurns = options.maxTurns + graceTurns;

  const mcpTools = options.toolDefinitions.filter((tool) => tool.function.name.startsWith("mcp__"));
  const availableToolDefinitions = options.strictToolDefinitions
    ? options.toolDefinitions
    : getAllToolDefinitions(mcpTools);
  const strictAllowedNames = options.strictToolDefinitions
    ? new Set(options.toolDefinitions.map((tool) => tool.function.name))
    : undefined;
  const buildCurrentTools = () =>
    buildAgentTools(
      sessionId,
      options.mode,
      resolveSessionLoopToolDefinitions(
        sessionId,
        options.mode,
        options.toolDefinitions,
        options.strictToolDefinitions,
      ),
      availableToolDefinitions,
      strictAllowedNames,
    );
  const agentTools = buildCurrentTools();

  let totalUsage: LlmUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheWriteTokens: 0,
  };
  let finalText = "";
  let assistantMessageId: number | null = null;
  let turnCount = 0;
  let toolCount = 0;
  let questionCallsThisTurn = 0;
  let wrapUpInjected = false;
  let providerAttempt = 0;
  let latestPersistedMessageId = Math.max(
    options.sourceBoundaryMessageId ?? 0,
    ...(options.sourceRows ?? []).map((row) => row.id),
  );
  let latestCompactedThroughMessageId = !isSubagent
    ? (await store.getLatestCompaction(
        sessionId,
        options.sourceBoundaryMessageId,
      ))?.compactedThroughMessageId ?? 0
    : 0;

  let initialMessages = options.messages;
  if (!isSubagent && options.sourceRows) {
    initialMessages = await maybeCompactMessages(
      initialMessages,
      sessionId,
      sessionModel,
      userId,
      { ...kernel, models: sessionModels },
      options.sourceRows,
      sessionApiKey,
      options.sourceBoundaryMessageId,
    );
    latestCompactedThroughMessageId = (await store.getLatestCompaction(
      sessionId,
      options.sourceBoundaryMessageId,
    ))?.compactedThroughMessageId ?? 0;
  }

  const initialEstimate = estimateContextTokens(initialMessages);
  const providerContextBudget = Math.max(
    0,
    sessionModel.contextWindow - compactionConfig.settings.reserveTokens,
  );
  if (initialEstimate.tokens > providerContextBudget) {
    throw new ContextOverflowError(initialEstimate.tokens, providerContextBudget);
  }
  if (!isSubagent) {
    await updateMainContextUsage({
      sessionId,
      userId,
      tokens: initialEstimate.tokens,
      contextWindow: sessionModel.contextWindow,
      model: sessionModel.id,
      provider: sessionModel.provider,
      throughMessageId: options.sourceBoundaryMessageId ?? latestPersistedMessageId,
      latestMessageId: latestPersistedMessageId,
      compactedThroughMessageId: latestCompactedThroughMessageId,
    });
  }

  const context: AgentContext = {
    systemPrompt: options.systemPrompt,
    messages: initialMessages,
    tools: agentTools,
  };

  const reservationOperationId = persist.kind === "session"
    ? persist.operationId
    : persist.invocationId ?? `subagent:${persist.runId}`;
  const reservation = await store.reserveTokenBudget({
    userId,
    operationId: reservationOperationId,
    estimatedTokens: estimateProviderTokenBudget({
      estimatedInputTokens: initialEstimate.tokens,
      maxOutputTokens: sessionModel.maxTokens,
      dailyLimit: config.maxDailyTokensPerUser,
    }),
    maxDailyTokens: config.maxDailyTokensPerUser,
    leaseMs: 30 * 60_000,
    ownerToken: reservationOperationId,
  });
  if (!reservation.reserved || !reservation.reservationId) {
    throw new QuotaExceededError(
      "daily_tokens",
      config.maxDailyTokensPerUser,
      reservation.dailyTokens + reservation.reservedTokens,
    );
  }
  if (!reservation.ownerToken || !reservation.generation) {
    throw new Error(`token reservation ${reservationOperationId} is owned by another executor`);
  }
  let reservationSettled = false;
  try {
    await runAgentLoopContinue(
      context,
      {
      model: sessionModel,
      convertToLlm,
      transformContext: async (agentMessages) => {
        const source = persist.kind === "session" ? "assistant" : "subagent";
        providerAttempt = await store.allocateTokenAttempt({
          sessionId,
          source,
          operationId: reservationOperationId,
          stage: "provider_round",
        });
        if (options.pollSteer) {
          const steer = await options.pollSteer();
          if (steer) {
            agentMessages = [
              ...agentMessages,
              { role: "user", content: `[steer] ${steer}`, timestamp: Date.now() },
            ];
            await options.onSteerApplied?.(steer);
          }
        }

        const estimate = estimateContextTokens(agentMessages);
        if (estimate.tokens > providerContextBudget) {
          throw new ContextOverflowError(estimate.tokens, providerContextBudget);
        }
        if (!isSubagent) {
          const latestMessageId = Math.max(
            options.sourceBoundaryMessageId ?? 0,
            ...(options.sourceRows ?? []).map((row) => row.id),
          );
          await updateMainContextUsage({
            sessionId,
            userId,
            tokens: estimate.tokens,
            contextWindow: sessionModel.contextWindow,
            model: sessionModel.id,
            provider: sessionModel.provider,
            throughMessageId: options.sourceBoundaryMessageId ?? latestMessageId,
            latestMessageId,
            compactedThroughMessageId: latestCompactedThroughMessageId,
          });
        }

        if (turnCount >= options.maxTurns && !wrapUpInjected) {
          wrapUpInjected = true;
          agentMessages = [
            ...agentMessages,
            { role: "user", content: WRAP_UP_MESSAGE, timestamp: Date.now() },
          ];
        }

        return agentMessages;
      },
      getApiKey: () => sessionApiKey,
      beforeToolCall: async (callContext) => {
        assertTurnNotAborted(sessionId);
        if (
          options.limitQuestionPerTurn &&
          callContext.toolCall.name === "question" &&
          questionCallsThisTurn >= 1
        ) {
          return {
            block: true,
            reason: "question tool already used this turn; proceed with reasonable defaults.",
          };
        }
        return undefined;
      },
      shouldStopAfterTurn: async () => turnCount >= hardStopTurns,
    },
    async (event: AgentEvent) => {
      if (isTurnAborted(sessionId)) {
        throw new TurnAbortedError();
      }

      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            if (options.onDelta) {
              await options.onDelta(event.assistantMessageEvent.delta);
            } else if (isSubagent && runId) {
              await publish(sessionId, {
                type: "subagent_delta",
                runId,
                text: event.assistantMessageEvent.delta,
                replica: config.replicaId,
              });
            }
          }
          break;
        case "message_end": {
          const message = event.message;
          if (message.role === "assistant") {
            const hasToolCalls = message.content.some((block) => block.type === "toolCall");
            if (persist.kind === "session") {
              const id = await persistSessionMessage(persist, message, providerAttempt);
          if (id != null) latestPersistedMessageId = Math.max(latestPersistedMessageId, id);
              if (!hasToolCalls && id != null) {
                assistantMessageId = id;
                finalText = extractAssistantText(message);
              }
            } else {
              await persistSubagentMessage(persist.runId, message);
              if (!hasToolCalls) {
                finalText = extractAssistantText(message);
              }
            }
          } else if (message.role === "toolResult") {
            if (persist.kind === "session") {
              await persistSessionMessage(persist, message, providerAttempt);
            } else {
              await persistSubagentMessage(persist.runId, message);
            }
          }
          break;
        }
        case "tool_execution_start": {
          toolCount += 1;
          const skillDetail =
            event.toolName === "skill" && typeof event.args?.name === "string"
              ? String(event.args.name)
              : undefined;
          if (isSubagent && runId) {
            await publish(sessionId, {
              type: "subagent_tool_start",
              runId,
              name: event.toolName,
              toolCallId: event.toolCallId,
              replica: config.replicaId,
              ...(skillDetail ? { detail: skillDetail } : {}),
            });
          } else {
            await publish(sessionId, {
              type: "tool_start",
              name: event.toolName,
              toolCallId: event.toolCallId,
              replica: config.replicaId,
              ...(skillDetail ? { detail: skillDetail } : {}),
            });
          }
          break;
        }
        case "tool_execution_end":
          if (event.toolName === "question" && !event.isError) {
            questionCallsThisTurn += 1;
          }
          if (event.toolName === "activate_tools" || event.toolName === "reset_active_tools") {
            context.tools = buildCurrentTools();
          }
          if (isSubagent && runId) {
            await publish(sessionId, {
              type: "subagent_tool_result",
              runId,
              name: event.toolName,
              toolCallId: event.toolCallId,
              isError: event.isError,
              replica: config.replicaId,
            });
          } else {
            await publish(sessionId, {
              type: "tool_result",
              name: event.toolName,
              toolCallId: event.toolCallId,
              isError: event.isError,
              replica: config.replicaId,
            });
          }
          break;
        case "turn_end":
          if (event.message.role === "assistant") {
            turnCount += 1;
            questionCallsThisTurn = 0;
            totalUsage = mergeUsage(totalUsage, usageToLlm(event.message.usage));
            const receiptStatus = event.message.stopReason === "aborted"
              ? "aborted"
              : event.message.stopReason === "error"
                ? "error"
                : "success";
            if (persist.kind === "session") {
              await store.logTokenUsage({
                usageKey: `${persist.operationId}:${providerAttempt}`,
                sessionId,
                userId,
                source: "assistant",
                operationId: persist.operationId,
                attempt: providerAttempt,
                stage: "provider_round",
                provider: event.message.provider,
                model: event.message.model,
                inputTokens: event.message.usage.input,
                outputTokens: event.message.usage.output,
                reasoningTokens: Number(
                  (event.message.usage as Usage & { reasoning?: number }).reasoning ?? 0,
                ),
                cacheReadTokens: event.message.usage.cacheRead,
                cacheWriteTokens: event.message.usage.cacheWrite,
                status: receiptStatus,
              });
            } else if (persist.invocationId) {
              await store.logTokenUsage({
                usageKey: `subagent:${persist.runId}:${persist.invocationId}:${providerAttempt}:provider_round`,
                sessionId,
                userId,
                source: "subagent",
                operationId: persist.invocationId,
                attempt: providerAttempt,
                stage: "provider_round",
                subagentRunId: persist.runId,
                provider: event.message.provider,
                model: event.message.model,
                inputTokens: event.message.usage.input,
                outputTokens: event.message.usage.output,
                reasoningTokens: Number(
                  (event.message.usage as Usage & { reasoning?: number }).reasoning ?? 0,
                ),
                cacheReadTokens: event.message.usage.cacheRead,
                cacheWriteTokens: event.message.usage.cacheWrite,
                status: receiptStatus,
              });
            }
            const text = extractAssistantText(event.message);
            const hasToolCalls = event.message.content.some((block) => block.type === "toolCall");
            if (!hasToolCalls && text.trim()) {
              finalText = text;
              if (options.mode === "plan" && !isSubagent) {
                await store.setSessionPlanText(sessionId, text.trim());
                setPlanPreview(sessionId, text.trim());
                await publish(sessionId, {
                  type: "plan_update",
                  text: text.trim(),
                  replica: config.replicaId,
                });
              }
              await options.onPlanUpdate?.(text.trim());
            }
          }
          break;
        default:
          break;
      }
    },
      options.signal ?? getTurnAbortSignal(sessionId),
      (model, llmContext, streamOptions) =>
        kernel.models.streamSimple(model, llmContext, streamOptions),
    );
    await store.settleTokenBudget({
      reservationId: reservation.reservationId,
      ownerToken: reservation.ownerToken!,
      generation: reservation.generation!,
      actualInputTokens: totalUsage.inputTokens ?? 0,
      actualOutputTokens: totalUsage.outputTokens ?? 0,
    });
    reservationSettled = true;
  } finally {
    if (!isSubagent) {
      await refreshMainContextUsageFromMessages({
        sessionId,
        userId,
        messages: context.messages,
        contextWindow: sessionModel.contextWindow,
        model: sessionModel.id,
        provider: sessionModel.provider,
        throughMessageId: options.sourceBoundaryMessageId ?? latestPersistedMessageId,
        latestMessageId: latestPersistedMessageId,
        compactedThroughMessageId: latestCompactedThroughMessageId,
      }).catch((error) => {
        console.warn(JSON.stringify({
          level: "warn",
          event: "context_snapshot_final_update_failed",
          replicaId: config.replicaId,
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        }));
      });
    }
    if (!reservationSettled) {
      await store.releaseTokenBudget({
        reservationId: reservation.reservationId,
        ownerToken: reservation.ownerToken!,
        generation: reservation.generation!,
      });
    }
  }

  if (turnCount >= hardStopTurns && !finalText) {
    finalText = "Stopped: maximum tool rounds reached.";
    if (persist.kind === "session") {
      assistantMessageId = await store.insertMessage(sessionId, "assistant", finalText, {
        counter: persist.counter,
        recoveryMarker: persist.recovery ?? false,
      });
    } else {
      await store.insertSubagentMessage(persist.runId, "assistant", finalText);
    }
  }

  return { finalText, usage: totalUsage, assistantMessageId, toolCount };
}
