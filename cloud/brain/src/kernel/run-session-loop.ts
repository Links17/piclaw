import * as store from "@piclaw-cloud/store";
import type { RoundtripCounter } from "@piclaw-cloud/store/db";
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  generateSummary,
  runAgentLoopContinue,
  shouldCompact,
  type AgentContext,
  type AgentEvent,
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type Usage,
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
  toolResultMessageToRow,
} from "./message-map.ts";
import {
  assistantMessageToSubagentBlocks,
} from "./subagent-message-map.ts";
import { getKernelRuntime } from "./runtime.ts";
import { buildAgentTools } from "./tool-bridge.ts";

const DEFAULT_GRACE_TURNS = 5;
const WRAP_UP_MESSAGE =
  "Wrap up now — provide your final summary in the next response without more tools.";
const COMPACTION_TAIL_MESSAGES = 6;

async function maybeCompactMessages(
  agentMessages: AgentMessage[],
  sessionId: string,
  kernel: NonNullable<ReturnType<typeof getKernelRuntime>>,
): Promise<AgentMessage[]> {
  const estimate = estimateContextTokens(agentMessages);
  if (!shouldCompact(estimate.tokens, kernel.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    return agentMessages;
  }
  const summaryResult = await generateSummary(
    agentMessages,
    kernel.models,
    kernel.model,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    getTurnAbortSignal(sessionId),
  );
  if (!summaryResult.ok || !summaryResult.value.trim()) {
    return agentMessages;
  }
  const tail = agentMessages.slice(-COMPACTION_TAIL_MESSAGES);
  return [
    {
      role: "user",
      content: `[Previous context compacted]\n${summaryResult.value.trim()}`,
      timestamp: Date.now(),
    },
    ...tail,
  ];
}

export type SessionPersistTarget =
  | { kind: "session"; sessionId: string; counter: RoundtripCounter; recovery?: boolean }
  | { kind: "subagent"; sessionId: string; runId: string };

export interface RunAgentSessionLoopOptions {
  persist: SessionPersistTarget;
  messages: AgentMessage[];
  systemPrompt: string;
  mode: "plan" | "execute";
  toolDefinitions: ToolDefinition[];
  maxTurns: number;
  graceTurns?: number;
  onDelta?: (text: string) => Promise<void>;
  pollSteer?: () => Promise<string | null>;
  onSteerApplied?: (message: string) => Promise<void>;
  onPlanUpdate?: (text: string) => Promise<void>;
  limitQuestionPerTurn?: boolean;
}

export interface SessionLoopResult {
  finalText: string;
  usage: LlmUsage;
  assistantMessageId: number | null;
  toolCount: number;
}

function usageToLlm(usage: Usage): LlmUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedTokens: usage.cacheRead,
  };
}

function mergeUsage(total: LlmUsage, round: LlmUsage): LlmUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (round.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (round.outputTokens ?? 0),
    cachedTokens: (total.cachedTokens ?? 0) + (round.cachedTokens ?? 0),
  };
}

async function persistSessionMessage(
  target: Extract<SessionPersistTarget, { kind: "session" }>,
  message: AssistantMessage | ToolResultMessage,
): Promise<number | null> {
  if (message.role === "assistant") {
    const row = assistantMessageToRow(message);
    return store.insertMessage(target.sessionId, "assistant", row.content, {
      counter: target.counter,
      contentBlocks: row.contentBlocks ?? null,
      recoveryMarker: target.recovery ?? false,
    });
  }
  const row = toolResultMessageToRow(message);
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
  const isSubagent = persist.kind === "subagent";
  const runId = isSubagent ? persist.runId : undefined;
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;
  const hardStopTurns = options.maxTurns + graceTurns;

  const agentTools = buildAgentTools(sessionId, options.mode, options.toolDefinitions);

  let totalUsage: LlmUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let finalText = "";
  let assistantMessageId: number | null = null;
  let turnCount = 0;
  let toolCount = 0;
  let questionCallsThisTurn = 0;
  let wrapUpInjected = false;

  const context: AgentContext = {
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: agentTools,
  };

  await runAgentLoopContinue(
    context,
    {
      model: kernel.model,
      convertToLlm,
      transformContext: async (agentMessages) => {
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
        if (!isSubagent) {
          setContextUsage(sessionId, {
            tokens: estimate.tokens,
            contextWindow: kernel.model.contextWindow,
            percent: Math.min(100, Math.round((estimate.tokens / kernel.model.contextWindow) * 100)),
          });
        }

        agentMessages = await maybeCompactMessages(agentMessages, sessionId, kernel);

        if (turnCount >= options.maxTurns && !wrapUpInjected) {
          wrapUpInjected = true;
          agentMessages = [
            ...agentMessages,
            { role: "user", content: WRAP_UP_MESSAGE, timestamp: Date.now() },
          ];
        }

        return agentMessages;
      },
      getApiKey: () => config.openaiApiKey,
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
              const id = await persistSessionMessage(persist, message);
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
              await persistSessionMessage(persist, message);
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
          if (event.toolName === "question") {
            questionCallsThisTurn += 1;
          }
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
    getTurnAbortSignal(sessionId),
    (model, llmContext, streamOptions) => kernel.models.streamSimple(model, llmContext, streamOptions),
  );

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
