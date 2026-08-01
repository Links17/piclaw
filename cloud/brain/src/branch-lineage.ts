import * as store from "@piclaw-cloud/store";
import { chatJidToSessionId, sessionToBranchChat } from "./web-adapter.ts";

export function normalizeForkMessageId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function normalizeForkTitle(value: unknown, parentTitle: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title) return title;
  const parent = parentTitle.trim() || "Chat";
  return `${parent} (fork)`;
}

export interface BranchLineageRow {
  id: string;
  user_id: string;
  title: string;
  sandbox_id: string | null;
  parent_session_id: string | null;
  forked_from_message_id: number | null;
  inherited_message_count: number;
}

export async function createForkedChatBranch(
  sourceChatJid: string,
  userId: string,
  requestedTitle?: unknown,
  forkMessageId?: unknown,
) {
  const sourceId = chatJidToSessionId(sourceChatJid);
  if (!sourceId) throw new Error("source_chat_jid is required");
  const source = await store.getSessionForUser(sourceId, userId);
  if (!source) throw new Error(`Unknown chat branch: ${sourceId}`);

  const messages = await store.listMessages(sourceId, 5000);
  const requestedId = normalizeForkMessageId(forkMessageId);
  const cutoffIndex = requestedId == null
    ? messages.length
    : messages.findIndex((row) => row.id === requestedId) + 1;
  if (cutoffIndex <= 0) throw new Error(`Unknown fork message: ${requestedId}`);

  const branchId = `web:${crypto.randomUUID()}`;
  const title = normalizeForkTitle(requestedTitle, source.title);
  const inherited = messages.slice(0, cutoffIndex);
  if (inherited.length === 0) throw new Error("Cannot fork an empty session");
  await store.createForkedSession(
    branchId,
    title,
    userId,
    sourceId,
    requestedId ?? inherited.at(-1)?.id ?? null,
    inherited,
  );
  const branch = await store.getSessionForUser(branchId, userId);
  if (!branch) throw new Error("Failed to create forked session");
  return sessionToBranchChat(branch);
}

export async function mergeChatBranchIntoParent(chatJid: string, userId: string) {
  const branchId = chatJidToSessionId(chatJid);
  const branch = await store.getSessionForUser(branchId, userId);
  if (!branch) throw new Error(`Unknown chat branch: ${branchId}`);
  if (!branch.parent_session_id) throw new Error("Chat branch has no parent");

  const parent = await store.getSessionForUser(branch.parent_session_id, userId);
  if (!parent) throw new Error(`Unknown parent session: ${branch.parent_session_id}`);
  const branchMessages = await store.listMessages(branch.id, 5000);
  const inheritedCount = Math.max(0, Number(branch.inherited_message_count) || 0);
  const additions = branchMessages.slice(inheritedCount);
  if (additions.length > 0) {
    await store.appendMessagesToSession(parent.id, additions);
  }
  const archived = await store.deleteSession(branch.id, userId);
  return {
    parent: sessionToBranchChat(parent),
    branch: sessionToBranchChat(archived),
    merged_message_count: additions.length,
  };
}
