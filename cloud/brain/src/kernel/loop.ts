/**
 * Turn executor kernel loop — delegates to shared runAgentSessionLoop.
 */
import * as store from "@piclaw-cloud/store";
import { newCounter } from "@piclaw-cloud/store/db";
import { config } from "../config.ts";
import { rowsToAgentMessages } from "./message-map.ts";
import { runAgentSessionLoop } from "./run-session-loop.ts";
import { getKernelRuntime } from "./runtime.ts";
import { resolveSessionKernelModel, resolveModelIdForLogging } from "./resolve-model.ts";
import { buildSystemPrompt } from "../llm/messages.ts";
import { buildSkillsPromptSection } from "../skills/registry.ts";
import { getDispatchMcpTools } from "../tools/dispatcher.ts";
import { getToolDefinitionsForMode } from "../tools/schemas.ts";
import { pollSessionSteerMessage } from "../subagents/channels.ts";
import type { LlmUsage } from "../llm.ts";

async function buildTurnContext(sessionId: string) {
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

export async function runKernelToolLoop(
  sessionId: string,
  counter: ReturnType<typeof newCounter>,
  onDelta: (text: string) => Promise<void>,
  options: { recovery?: boolean } = {},
): Promise<{ finalText: string; usage: LlmUsage; assistantMessageId: number | null }> {
  const kernel = getKernelRuntime();
  if (!kernel) {
    throw new Error("Agent kernel is not initialized");
  }

  const session = await store.getSession(sessionId);
  const userId = session?.user_id ?? "default-user";
  const turnContext = await buildTurnContext(sessionId);
  const sessionModel = await resolveSessionKernelModel(sessionId);
  const rows = await store.hydrate(sessionId, counter);
  const messages = rowsToAgentMessages(rows, resolveModelIdForLogging(sessionModel));
  if (messages.length === 0 || messages[messages.length - 1]?.role === "assistant") {
    throw new Error("Cannot start kernel loop: context must end with user or toolResult message");
  }

  const systemPrompt = buildSystemPrompt({
    mode: turnContext.mode,
    skillsSection: turnContext.skillsSection,
    planText: turnContext.planText,
  });

  const result = await runAgentSessionLoop({
    persist: { kind: "session", sessionId, counter, recovery: options.recovery },
    messages,
    systemPrompt,
    mode: turnContext.mode,
    toolDefinitions: turnContext.tools,
    model: sessionModel,
    userId,
    maxTurns: config.maxToolRounds,
    onDelta,
    limitQuestionPerTurn: true,
    pollSteer: () => pollSessionSteerMessage(sessionId),
    onSteerApplied: async (message) => {
      const { publish } = await import("../events.ts");
      await publish(sessionId, { type: "steer_applied", content: message, replica: config.replicaId });
    },
  });

  return {
    finalText: result.finalText,
    usage: result.usage,
    assistantMessageId: result.assistantMessageId,
  };
}
