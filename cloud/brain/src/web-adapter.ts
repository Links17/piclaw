/**
 * Web UI compatibility — chat_jid ↔ session_id, timeline posts, agent routes.
 */
import * as store from "@piclaw-cloud/store";
import { config } from "./config.ts";
import { submitMessage } from "./turn.ts";

export function chatJidToSessionId(chatJid: string | null | undefined): string {
  const normalized = typeof chatJid === "string" && chatJid.trim() ? chatJid.trim() : config.defaultChatJid;
  return normalized;
}

export async function ensureChatSession(chatJid: string): Promise<string> {
  const sessionId = chatJidToSessionId(chatJid);
  const existing = await store.getSession(sessionId);
  if (!existing) {
    await store.createSession(sessionId, chatJid === config.defaultChatJid ? "Default" : chatJid);
  }
  return sessionId;
}

function messageToPost(row: store.MessageRow, chatJid: string) {
  const isBot = row.role === "assistant";
  return {
    id: row.id,
    chat_jid: chatJid,
    timestamp: row.created_at,
    data: {
      content: row.content,
      is_bot_message: isBot,
      author: isBot ? "assistant" : "user",
      recovery: row.recovery_marker,
    },
  };
}

export async function getTimeline(chatJid: string, limit = 10, before?: number | null) {
  const sessionId = await ensureChatSession(chatJid);
  const rows = await store.listMessages(sessionId, Math.max(limit, 50));
  let posts = rows.map((row) => messageToPost(row, chatJid));
  if (before != null && Number.isFinite(before)) {
    posts = posts.filter((p) => p.id < before);
  }
  if (posts.length > limit) {
    posts = posts.slice(-limit);
  }
  const oldestId = posts.length > 0 ? posts[0].id : null;
  const hasMore = oldestId !== null && rows.length > posts.length;
  return { posts, limit, has_more: hasMore };
}

export async function getAgentStatus(chatJid: string) {
  const sessionId = await ensureChatSession(chatJid);
  const cursor = await store.getCursor(sessionId);
  const locked = await store.isSessionLocked(sessionId);
  const status = locked || cursor?.inflight_message_id ? "streaming" : "idle";
  return {
    status,
    inflight: cursor?.inflight_message_id ?? null,
    locked,
  };
}

export async function getQueueState(chatJid: string) {
  const sessionId = await ensureChatSession(chatJid);
  const items = await store.getQueuedFollowups(sessionId);
  return {
    count: items.length,
    items: items.map((content, index) => ({
      row_id: `q-${index}`,
      content,
      status: "queued",
    })),
  };
}

export async function sendAgentMessage(chatJid: string, content: string, mode?: string | null) {
  const sessionId = await ensureChatSession(chatJid);
  const outcome = await submitMessage(sessionId, content);
  if (mode === "queue" && outcome === "ran") {
    return { ok: true, queued: false, ran: true };
  }
  return { ok: true, outcome, queued: outcome === "queued" };
}

export async function listSessions() {
  return store.listSessions();
}

export function agentResponseSsePayload(chatJid: string, messageId: number, content: string, recovery?: boolean) {
  return {
    id: messageId,
    chat_jid: chatJid,
    timestamp: new Date().toISOString(),
    data: {
      content,
      is_bot_message: true,
      author: "assistant",
      recovery: recovery ?? false,
    },
  };
}
