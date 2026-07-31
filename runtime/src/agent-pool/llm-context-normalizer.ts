import type { AgentMessage } from "@piclaw/agent-kernel";
import type { Context, Message } from "@piclaw/agent-kernel";

const MAX_COERCED_TEXT_CHARS = 4_000;

type MutableRecord = Record<string, unknown>;

type NormalizeResult<T> = {
  value: T;
  changed: boolean;
};

function isRecord(value: unknown): value is MutableRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return "";
    return serialized.length > MAX_COERCED_TEXT_CHARS
      ? `${serialized.slice(0, MAX_COERCED_TEXT_CHARS)}…`
      : serialized;
  } catch {
    return "";
  }
}

function normalizeTimestamp(value: unknown): NormalizeResult<number> {
  if (isFiniteNumber(value)) return { value, changed: false };
  return { value: 0, changed: true };
}

function normalizeTextImageContent(content: unknown): NormalizeResult<Array<MutableRecord>> {
  if (!Array.isArray(content)) {
    return {
      value: [{ type: "text", text: coerceText(content) }],
      changed: true,
    };
  }

  let changed = false;
  const blocks: MutableRecord[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      changed = true;
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text === "string") {
        blocks.push(block);
      } else {
        blocks.push({ ...block, text: coerceText(block.text) });
        changed = true;
      }
      continue;
    }
    if (block.type === "image") {
      if (typeof block.mimeType === "string" && typeof block.data === "string") {
        blocks.push(block);
      } else {
        changed = true;
      }
      continue;
    }
    changed = true;
  }

  if (blocks.length === content.length && !changed) {
    return { value: content as MutableRecord[], changed: false };
  }

  return {
    value: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
    changed: true,
  };
}

function normalizeUserContent(content: unknown): NormalizeResult<string | Array<MutableRecord>> {
  if (typeof content === "string") return { value: content, changed: false };
  if (Array.isArray(content)) return normalizeTextImageContent(content);
  return { value: coerceText(content), changed: true };
}

function normalizeAssistantContent(content: unknown): NormalizeResult<Array<MutableRecord>> {
  if (!Array.isArray(content)) {
    return { value: [{ type: "text", text: coerceText(content) }], changed: true };
  }

  let changed = false;
  const blocks: MutableRecord[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      changed = true;
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text === "string") blocks.push(block);
      else {
        blocks.push({ ...block, text: coerceText(block.text) });
        changed = true;
      }
      continue;
    }
    if (block.type === "thinking") {
      if (typeof block.thinking === "string") blocks.push(block);
      else {
        blocks.push({ ...block, thinking: coerceText(block.thinking) });
        changed = true;
      }
      continue;
    }
    if (block.type === "toolCall") {
      blocks.push({
        ...block,
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        arguments: isRecord(block.arguments) ? block.arguments : {},
      });
      changed = changed
        || typeof block.id !== "string"
        || typeof block.name !== "string"
        || !isRecord(block.arguments);
      continue;
    }
    changed = true;
  }

  if (blocks.length === content.length && !changed) {
    return { value: content as MutableRecord[], changed: false };
  }

  return {
    value: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
    changed: true,
  };
}

function normalizeMessageLike<T extends MutableRecord>(message: T): NormalizeResult<T> {
  const role = message.role;
  if (role === "user") {
    const content = normalizeUserContent(message.content);
    const timestamp = normalizeTimestamp(message.timestamp);
    if (!content.changed && !timestamp.changed) return { value: message, changed: false };
    return {
      value: { ...message, content: content.value, timestamp: timestamp.value },
      changed: true,
    };
  }

  if (role === "custom") {
    const content = normalizeUserContent(message.content);
    const timestamp = normalizeTimestamp(message.timestamp);
    if (!content.changed && !timestamp.changed) return { value: message, changed: false };
    return {
      value: { ...message, content: content.value, timestamp: timestamp.value },
      changed: true,
    };
  }

  if (role === "assistant") {
    const content = normalizeAssistantContent(message.content);
    const timestamp = normalizeTimestamp(message.timestamp);
    if (!content.changed && !timestamp.changed) return { value: message, changed: false };
    return {
      value: { ...message, content: content.value, timestamp: timestamp.value },
      changed: true,
    };
  }

  if (role === "toolResult") {
    const content = normalizeTextImageContent(message.content);
    const timestamp = normalizeTimestamp(message.timestamp);
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const isError = typeof message.isError === "boolean" ? message.isError : false;
    const changed = content.changed
      || timestamp.changed
      || toolCallId !== message.toolCallId
      || toolName !== message.toolName
      || isError !== message.isError;
    if (!changed) return { value: message, changed: false };
    return {
      value: { ...message, content: content.value, timestamp: timestamp.value, toolCallId, toolName, isError },
      changed: true,
    };
  }

  if (role === "branchSummary") {
    const summary = coerceText(message.summary);
    const fromId = typeof message.fromId === "string" ? message.fromId : "root";
    const timestamp = normalizeTimestamp(message.timestamp);
    const changed = summary !== message.summary || fromId !== message.fromId || timestamp.changed;
    if (!changed) return { value: message, changed: false };
    return {
      value: { ...message, summary, fromId, timestamp: timestamp.value },
      changed: true,
    };
  }

  if (role === "compactionSummary") {
    const summary = coerceText(message.summary);
    const tokensBefore = isFiniteNumber(message.tokensBefore) ? message.tokensBefore : 0;
    const timestamp = normalizeTimestamp(message.timestamp);
    const changed = summary !== message.summary || tokensBefore !== message.tokensBefore || timestamp.changed;
    if (!changed) return { value: message, changed: false };
    return {
      value: { ...message, summary, tokensBefore, timestamp: timestamp.value },
      changed: true,
    };
  }

  return { value: message, changed: false };
}

export function normalizeLlmMessages<T extends readonly unknown[]>(messages: T): NormalizeResult<AgentMessage[]> {
  let changed = false;
  const normalized: AgentMessage[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      changed = true;
      continue;
    }
    const result = normalizeMessageLike(message);
    normalized.push(result.value as unknown as AgentMessage);
    changed = changed || result.changed;
  }

  return { value: normalized, changed };
}

export function normalizeAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return normalizeLlmMessages(messages).value;
}

export function normalizeLlmContext<T extends Context>(context: T): T {
  const normalized = normalizeLlmMessages(context.messages ?? []);
  if (!normalized.changed) return context;
  return { ...context, messages: normalized.value as Message[] };
}
