import * as store from "@piclaw-cloud/store";
import type { SessionRecordingMeta, SessionTraceEvent } from "@piclaw-cloud/store";
import {
  normalizeRedactionOptions,
  previewSessionRecordingRedaction,
  sanitizeForRecording,
  type SessionRecordingMode,
} from "./redaction.ts";

export const SESSION_TRACE_SCHEMA_VERSION = 1;

export type SessionTraceEventKind =
  | "recording_started"
  | "recording_stopped"
  | "timeline_message"
  | "sse_event"
  | "user_input"
  | "assistant_output"
  | "tool_activity"
  | "status"
  | "fixture_note";

interface ActiveRecordingState {
  meta: SessionRecordingMeta;
  userId: string;
  startedMs: number;
  seq: number;
}

const activeByChat = new Map<string, ActiveRecordingState>();

function normalizeMode(value: unknown): SessionRecordingMode {
  return value === "metadata" || value === "full" || value === "redacted" ? value : "redacted";
}

function normalizeChatJid(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "web:default";
}

function normalizeTitle(value: unknown, chatJid: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || `Recording ${chatJid} ${new Date().toISOString()}`;
}

function createRecordingId(): string {
  return `rec-${crypto.randomUUID()}`;
}

async function appendEvent(
  state: ActiveRecordingState,
  kind: SessionTraceEventKind,
  data: unknown,
): Promise<SessionTraceEvent> {
  const redactions: string[] = [];
  const now = Date.now();
  const event: SessionTraceEvent = {
    version: SESSION_TRACE_SCHEMA_VERSION,
    recording_id: state.meta.id,
    seq: ++state.seq,
    kind,
    chat_jid: state.meta.chatJid,
    at: new Date(now).toISOString(),
    t_ms: Math.max(0, now - state.startedMs),
    data: sanitizeForRecording(data, state.meta.mode, redactions, "", state.meta.redaction),
    ...(redactions.length > 0 ? { redactions: Array.from(new Set(redactions)) } : {}),
  };
  await store.appendSessionRecordingEvent(event);
  state.meta.eventCount = event.seq;
  await store.updateSessionRecordingMeta(state.meta);
  return event;
}

export async function startSessionRecording(options: {
  chatJid?: unknown;
  title?: unknown;
  mode?: unknown;
  redaction?: unknown;
  userId: string;
}): Promise<SessionRecordingMeta> {
  const chatJid = normalizeChatJid(options.chatJid);
  const existing = activeByChat.get(chatJid);
  if (existing) return { ...existing.meta };

  const id = createRecordingId();
  const meta = await store.createSessionRecording({
    id,
    chatJid,
    title: normalizeTitle(options.title, chatJid),
    mode: normalizeMode(options.mode),
    redaction: normalizeRedactionOptions(options.redaction),
    userId: options.userId,
  });
  const state: ActiveRecordingState = { meta, userId: options.userId, startedMs: Date.now(), seq: 0 };
  activeByChat.set(chatJid, state);
  await appendEvent(state, "recording_started", {
    title: meta.title,
    mode: meta.mode,
    redaction: meta.redaction || null,
  });
  return { ...state.meta };
}

export async function stopSessionRecording(
  chatJidOrId: string,
  userId: string,
): Promise<SessionRecordingMeta | null> {
  const key = String(chatJidOrId || "").trim();
  let state = activeByChat.get(key) || null;
  if (state?.userId !== userId) state = null;
  if (!state) {
    for (const candidate of activeByChat.values()) {
      if (candidate.meta.id === key && candidate.userId === userId) {
        state = candidate;
        break;
      }
    }
  }
  if (!state) {
    const byId = await store.getSessionRecordingMetaForUser(key, userId);
    if (byId?.status === "recording") {
      const byChat = activeByChat.get(byId.chatJid);
      state = byChat?.meta.id === byId.id ? byChat : null;
    }
  }
  if (!state) return null;

  await appendEvent(state, "recording_stopped", { reason: "operator_stop" });
  state.meta.status = "stopped";
  state.meta.endedAt = new Date().toISOString();
  await store.updateSessionRecordingMeta(state.meta);
  activeByChat.delete(state.meta.chatJid);
  return { ...state.meta };
}

export async function listSessionRecordings(userId: string): Promise<SessionRecordingMeta[]> {
  return store.listSessionRecordingsForUser(userId);
}

export async function getSessionRecording(
  id: string,
  userId: string,
): Promise<{ meta: SessionRecordingMeta; events: SessionTraceEvent[] } | null> {
  const meta = await store.getSessionRecordingMetaForUser(id, userId);
  if (!meta) return null;
  const events = await store.listSessionRecordingEventsForUser(id, userId);
  return { meta, events };
}

export async function deleteSessionRecording(id: string, userId: string): Promise<boolean> {
  for (const [chatJid, state] of activeByChat) {
    if (state.meta.id === id && state.userId === userId) activeByChat.delete(chatJid);
  }
  return store.deleteSessionRecordingForUser(id, userId);
}

export async function getActiveSessionRecording(
  chatJid: string,
  userId: string,
): Promise<SessionRecordingMeta | null> {
  const state = activeByChat.get(normalizeChatJid(chatJid));
  if (state?.userId === userId) return { ...state.meta };
  return store.getActiveSessionRecordingForUser(normalizeChatJid(chatJid), userId);
}

export async function listActiveSessionRecordings(userId: string): Promise<SessionRecordingMeta[]> {
  const active = await store.listActiveSessionRecordingsForUser(userId);
  const seen = new Set(active.map((row) => row.chatJid));
  for (const state of activeByChat.values()) {
    if (state.userId === userId && !seen.has(state.meta.chatJid)) active.push({ ...state.meta });
  }
  return active;
}

export { previewSessionRecordingRedaction };

export async function recordSessionFixtureNote(chatJid: string, data: unknown): Promise<void> {
  const state = activeByChat.get(normalizeChatJid(chatJid));
  if (!state) return;
  await appendEvent(state, "fixture_note", data);
}

export async function recordTimelineInteraction(interaction: {
  id?: number;
  chat_jid?: string;
  timestamp?: string;
  data?: { type?: string; content?: string };
} | null | undefined): Promise<void> {
  if (!interaction?.chat_jid) return;
  const state = activeByChat.get(interaction.chat_jid);
  if (!state) return;
  const kind = interaction.data?.type === "user_message"
    ? "user_input"
    : interaction.data?.type === "agent_response"
      ? "assistant_output"
      : "timeline_message";
  await appendEvent(state, kind, {
    interaction_id: interaction.id,
    timestamp: interaction.timestamp,
    data: interaction.data,
  });
}

function kindFromInternalEvent(event: { type: string; [key: string]: unknown }): SessionTraceEventKind {
  switch (event.type) {
    case "message":
      return event.role === "user" ? "user_input" : "assistant_output";
    case "tool_start":
    case "tool_result":
    case "subagent_tool_start":
    case "subagent_tool_result":
      return "tool_activity";
    case "turn_started":
    case "turn_done":
    case "turn_failed":
    case "turn_aborted":
      return "status";
    default:
      return "sse_event";
  }
}

export async function recordInternalSessionEvent(
  sessionId: string,
  event: { type: string; [key: string]: unknown },
): Promise<void> {
  const state = activeByChat.get(sessionId);
  if (!state) return;
  try {
    await appendEvent(state, kindFromInternalEvent(event), event);
  } catch (error) {
    console.warn(`[recordings] failed to append event for ${sessionId}:`, error);
  }
}

export function resetSessionRecordingsForTests(): void {
  activeByChat.clear();
}
