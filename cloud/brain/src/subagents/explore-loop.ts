/**
 * Brain-side readonly loops for explore/plan subagent types.
 */
import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import { streamCompletionRound, LlmNotConfiguredError, type LlmUsage } from "../llm.ts";
import { type OpenAiMessage, type OpenAiToolCall } from "../llm/messages.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { getToolDefinitionsForMode } from "../tools/schemas.ts";
import { pollSteerMessage } from "./channels.ts";
import { assertTurnNotAborted, getTurnAbortSignal } from "../turn-abort.ts";

const READONLY_TOOLS = getToolDefinitionsForMode("plan");

function toOpenAiToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): OpenAiToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
}

function mergeUsage(total: LlmUsage, round: LlmUsage): LlmUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (round.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (round.outputTokens ?? 0),
    cachedTokens: (total.cachedTokens ?? 0) + (round.cachedTokens ?? 0),
  };
}

async function streamReadonlyRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof streamCompletionRound>>> {
  const signal = getTurnAbortSignal(sessionId);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser && "content" in lastUser ? String(lastUser.content ?? "") : "";
  const isMockPrefix = prompt.startsWith("mock-coding:") || prompt.startsWith("mock-tools:");
  if (isMockPrefix) {
    return streamCompletionRound(messages, onDelta, READONLY_TOOLS, { sessionId, signal });
  }
  if (config.openaiBaseUrl && config.openaiApiKey) {
    assertTurnNotAborted(sessionId);
    const response = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.openaiModel,
        messages,
        tools: READONLY_TOOLS,
        tool_choice: "auto",
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`readonly LLM HTTP ${response.status}: ${await response.text().catch(() => "")}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? "";
    if (text) await onDelta(text);
    const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "read",
      arguments: call.function?.arguments ?? "{}",
    }));
    return {
      text,
      toolCalls,
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? null,
        outputTokens: payload.usage?.completion_tokens ?? null,
        cachedTokens: null,
      },
    };
  }
  throw new LlmNotConfiguredError();
}

export async function runExploreLoop(
  sessionId: string,
  runId: string,
  prompt: string,
  options: { agentType: "explore" | "plan"; maxTurns?: number; constraints?: string },
): Promise<{ summary: string; artifacts: string[]; usage: LlmUsage; toolCount: number }> {
  const maxTurns = options.maxTurns ?? config.subagentMaxTurns;
  const systemPrompt =
    options.agentType === "plan"
      ? "You are a planning subagent. Produce a clear implementation plan. Use read/bash(readonly)/question/todo only. Do not modify files."
      : "You are an explore subagent. Investigate the codebase read-only using read/bash/question. Summarize findings.";

  const userContent = options.constraints ? `${prompt}\n\nConstraints:\n${options.constraints}` : prompt;
  await store.insertSubagentMessage(runId, "user", userContent);
  let messages: OpenAiMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: userContent,
    },
  ];
  let totalUsage: LlmUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let toolCount = 0;
  let summary = "";

  for (let round = 0; round < maxTurns; round += 1) {
    assertTurnNotAborted(sessionId);
    const steer = await pollSteerMessage(runId);
    if (steer) {
      messages.push({ role: "user", content: `[steer] ${steer}` });
      await publish(sessionId, {
        type: "subagent_steered",
        runId,
        message: steer,
        replica: config.replicaId,
      });
    }

    const result = await streamReadonlyRound(messages, async (delta) => {
      summary += delta;
      await publish(sessionId, { type: "subagent_delta", runId, text: delta, replica: config.replicaId });
    }, sessionId);
    totalUsage = mergeUsage(totalUsage, result.usage);

    if (result.toolCalls.length === 0) {
      summary = result.text || summary;
      if (summary.trim()) {
        await store.insertSubagentMessage(runId, "assistant", summary.trim());
      }
      break;
    }

    const toolCalls = toOpenAiToolCalls(result.toolCalls);
    messages.push({ role: "assistant", content: result.text || null, tool_calls: toolCalls });

    for (const call of result.toolCalls) {
      toolCount += 1;
      await publish(sessionId, {
        type: "subagent_tool_start",
        runId,
        name: call.name,
        toolCallId: call.id,
        replica: config.replicaId,
      });
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const toolResult = await dispatchTool(sessionId, call.name, args, "plan");
      await publish(sessionId, {
        type: "subagent_tool_result",
        runId,
        name: call.name,
        toolCallId: call.id,
        isError: toolResult.isError,
        replica: config.replicaId,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult.output });
      await store.insertSubagentMessage(runId, "tool", toolResult.output, {
        toolCallId: call.id,
        toolName: call.name,
      });
    }

    if (round >= maxTurns - 2) {
      messages.push({
        role: "user",
        content: "Wrap up now — provide your final summary in the next response without more tools.",
      });
    }
  }

  if (options.agentType === "plan" && summary.trim()) {
    await store.setSessionPlanText(sessionId, summary.trim());
    await publish(sessionId, {
      type: "plan_update",
      text: summary.trim(),
      replica: config.replicaId,
    });
  }

  return { summary: summary.trim() || "Subagent completed.", artifacts: [], usage: totalUsage, toolCount };
}
