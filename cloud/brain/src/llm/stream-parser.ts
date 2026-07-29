/** Accumulate OpenAI streaming chat.completion chunks into text + tool_calls. */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamAccumulator {
  text: string;
  toolCalls: ParsedToolCall[];
  finishReason: string | null;
}

interface ToolCallBuilder {
  id: string;
  name: string;
  arguments: string;
}

export function createStreamAccumulator(): StreamAccumulator {
  return { text: "", toolCalls: [], finishReason: null };
}

export function applyStreamChunk(
  acc: StreamAccumulator,
  payload: {
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
  },
): { textDelta?: string } {
  const choice = payload.choices?.[0];
  if (!choice) return {};

  if (choice.finish_reason) {
    acc.finishReason = choice.finish_reason;
  }

  const delta = choice.delta;
  if (!delta) return {};

  let textDelta: string | undefined;
  if (typeof delta.content === "string" && delta.content) {
    acc.text += delta.content;
    textDelta = delta.content;
  }

  if (Array.isArray(delta.tool_calls)) {
    const map = getToolBuilders(acc);
    for (const tc of delta.tool_calls) {
      const index = tc.index ?? 0;
      let builder = map.get(index);
      if (!builder) {
        builder = { id: "", name: "", arguments: "" };
        map.set(index, builder);
      }
      if (tc.id) builder.id = tc.id;
      if (tc.function?.name) builder.name = tc.function.name;
      if (tc.function?.arguments) builder.arguments += tc.function.arguments;
    }
    syncToolCalls(acc, map);
  }

  return textDelta ? { textDelta } : {};
}

const builderKey = Symbol("toolBuilders");

function getToolBuilders(acc: StreamAccumulator): Map<number, ToolCallBuilder> {
  const accAny = acc as StreamAccumulator & { [builderKey]?: Map<number, ToolCallBuilder> };
  if (!accAny[builderKey]) accAny[builderKey] = new Map();
  return accAny[builderKey]!;
}

function syncToolCalls(acc: StreamAccumulator, map: Map<number, ToolCallBuilder>): void {
  acc.toolCalls = [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({ id: b.id, name: b.name, arguments: b.arguments }))
    .filter((tc) => tc.id && tc.name);
}

export function finalizeStreamAccumulator(acc: StreamAccumulator): StreamAccumulator {
  return {
    text: acc.text,
    toolCalls: acc.toolCalls.filter((tc) => tc.id && tc.name),
    finishReason: acc.finishReason,
  };
}
