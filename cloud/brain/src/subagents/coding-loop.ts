/**
 * Isolated coding tool loop — runs in Brain but executes only via sandbox tools.
 * Used as fallback when sandbox pi worker is unavailable, and for mock-coding tests.
 */
import { config } from "../config.ts";
import { publish } from "../events.ts";
import { streamCompletionRound, type LlmUsage } from "../llm.ts";
import { type OpenAiMessage, type OpenAiToolCall } from "../llm/messages.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { CODING_TOOL_DEFINITIONS } from "../tools/coding-schemas.ts";

const MAX_CODING_ROUNDS = 8;

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

async function streamCodingRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
): Promise<Awaited<ReturnType<typeof streamCompletionRound>>> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser && "content" in lastUser ? String(lastUser.content ?? "") : "";
  if (prompt.startsWith("mock-coding:")) {
    return streamCompletionRound(messages, onDelta);
  }
  if (config.openaiBaseUrl && config.openaiApiKey) {
    return streamOpenAiCodingRound(messages, onDelta);
  }
  return streamCompletionRound(messages, onDelta);
}

async function streamOpenAiCodingRound(
  messages: OpenAiMessage[],
  onDelta: (text: string) => Promise<void>,
): Promise<Awaited<ReturnType<typeof streamCompletionRound>>> {
  const response = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages,
      tools: CODING_TOOL_DEFINITIONS,
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`coding LLM HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = payload.choices?.[0]?.message;
  const text = message?.content ?? "";
  if (text) await onDelta(text);
  const toolCalls =
    message?.tool_calls?.map((call, index) => ({
      id: call.id ?? `call_coding_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })) ?? [];
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

export async function runBrainCodingLoop(
  sessionId: string,
  runId: string,
  task: string,
  constraints?: string,
): Promise<{ summary: string; artifacts: string[]; usage: LlmUsage }> {
  const systemPrompt = [
    "You are a coding subagent working in /workspace inside an isolated sandbox.",
    "Use bash, read, write, and edit tools to complete the task.",
    "When done, respond with a concise summary of what you changed.",
    constraints ? `Constraints: ${constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = task;
  let messages: OpenAiMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let totalUsage: LlmUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let finalText = "";

  for (let round = 0; round < MAX_CODING_ROUNDS; round += 1) {
    const result = await streamCodingRound(messages, async (delta) => {
      await publish(sessionId, {
        type: "subagent_delta",
        runId,
        text: delta,
        replica: config.replicaId,
      });
    });
    totalUsage = mergeUsage(totalUsage, result.usage);

    if (result.toolCalls.length === 0) {
      finalText = result.text || "Coding subagent finished.";
      break;
    }

    const toolCalls = toOpenAiToolCalls(result.toolCalls);
    messages.push({ role: "assistant", content: result.text || null, tool_calls: toolCalls });

    for (const call of result.toolCalls) {
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
      const toolResult = await dispatchTool(sessionId, call.name, args);

      await publish(sessionId, {
        type: "subagent_tool_result",
        runId,
        name: call.name,
        toolCallId: call.id,
        isError: toolResult.isError,
        replica: config.replicaId,
      });

      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult.output });
    }

    if (round === MAX_CODING_ROUNDS - 1) {
      finalText = result.text || "Coding subagent stopped at max tool rounds.";
    }
  }

  const artifacts = extractArtifacts(finalText, task);
  return {
    summary: finalText,
    artifacts,
    usage: totalUsage,
  };
}

function extractArtifacts(summary: string, task: string): string[] {
  const artifacts = new Set<string>();
  const pathMatches = [...task.matchAll(/[\w./-]+\.(ino|ts|js|py|json|md)\b/g)];
  for (const match of pathMatches) {
    artifacts.add(match[0].replace(/^\.\//, "").replace(/^\/workspace\//, ""));
  }
  const matches = summary.match(/[\w./-]+\.(ino|ts|js|py|json|md)\b/g);
  for (const match of matches ?? []) {
    artifacts.add(match.replace(/^\.\//, "").replace(/^\/workspace\//, ""));
  }
  return [...artifacts];
}
