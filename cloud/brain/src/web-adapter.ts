/**
 * Web UI compatibility — chat_jid ↔ session_id, timeline posts, agent routes.
 */
import * as store from "@piclaw-cloud/store";
import { getDraft, getInflightTurn, getPendingQuestionState, getPlanPreview } from "./agent-run-state.ts";
import { answerPendingQuestion } from "./tools/question.ts";
import { setSessionMode as setTurnSessionMode } from "./turn.ts";
import {
  deleteUserSkill,
  installUserSkill,
  listUserSkillsForApi,
} from "./skills/registry.ts";
import { spawnAgent, getSubagentResult, stopSubagent, steerSubagent } from "./subagents/service.ts";
import { config } from "./config.ts";
import { abortSessionTurn, submitMessage, removeQueuedFollowup, steerQueuedFollowup, reorderQueuedFollowups } from "./turn.ts";
import { UNTITLED_SESSION_TITLE } from "@piclaw-cloud/store";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { requireSessionAccess } from "./auth.ts";

export { UNTITLED_SESSION_TITLE };

export function chatJidToSessionId(chatJid: string | null | undefined): string {
  return typeof chatJid === "string" ? chatJid.trim() : "";
}

export async function ensureChatSession(chatJid: string): Promise<string> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) {
    throw new Error("chat_jid is required");
  }
  const existing = await store.getSession(sessionId);
  if (!existing) {
    throw new Error(`Unknown chat session: ${sessionId}`);
  }
  return sessionId;
}

function normalizePostId(id: unknown): number {
  const numeric = typeof id === "number" ? id : Number(id);
  return Number.isFinite(numeric) ? numeric : 0;
}

function hasToolCalls(contentBlocks: unknown): boolean {
  if (!contentBlocks || typeof contentBlocks !== "object") return false;
  const blocks = contentBlocks as { tool_calls?: unknown[] };
  return Array.isArray(blocks.tool_calls) && blocks.tool_calls.length > 0;
}

/** Only user-facing timeline rows — hide internal tool-loop rows from classic UI. */
export function isTimelineVisibleMessage(row: store.MessageRow): boolean {
  if (row.role === "user") return true;
  if (row.role !== "assistant") return false;
  return !hasToolCalls(row.content_blocks);
}

function dedupePostsById<T extends { id: unknown }>(posts: T[]): T[] {
  const seen = new Set<number>();
  const deduped: T[] = [];
  for (const post of posts) {
    const id = normalizePostId(post.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ ...post, id });
  }
  return deduped;
}

export function messageToPost(row: store.MessageRow, chatJid: string) {
  const isBot = row.role === "assistant";
  return {
    id: normalizePostId(row.id),
    chat_jid: chatJid,
    timestamp: row.created_at,
    data: {
      type: isBot ? "agent_response" : "user_message",
      content: row.content,
      is_bot_message: isBot,
      author: isBot ? "assistant" : "user",
      recovery: row.recovery_marker,
    },
  };
}

export function userPostPayload(chatJid: string, messageId: number, content: string, timestamp?: string) {
  const id = normalizePostId(messageId);
  return {
    id,
    chat_jid: chatJid,
    timestamp: timestamp ?? new Date().toISOString(),
    data: {
      type: "user_message",
      content,
      is_bot_message: false,
      author: "user",
      thread_id: id,
    },
  };
}

export function agentResponseSsePayload(chatJid: string, messageId: number, content: string, recovery?: boolean) {
  return {
    id: normalizePostId(messageId),
    chat_jid: chatJid,
    timestamp: new Date().toISOString(),
    data: {
      type: "agent_response",
      content,
      is_bot_message: true,
      author: "assistant",
      recovery: recovery ?? false,
    },
  };
}

export async function getTimeline(chatJid: string, limit = 10, before?: number | null) {
  const sessionId = await ensureChatSession(chatJid);
  const rows = await store.listMessages(sessionId, Math.max(limit, 50));
  let posts = rows.filter(isTimelineVisibleMessage).map((row) => messageToPost(row, chatJid));
  posts = dedupePostsById(posts);
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
  const inflight = cursor?.inflight_message_id ?? null;
  const turnId = getInflightTurn(sessionId) ?? (inflight == null ? null : String(inflight));

  if (!locked && inflight == null) {
    return {
      status: "idle",
      chat_jid: chatJid,
      data: { type: "done", title: "Idle", chat_jid: chatJid },
    };
  }

  const draft = getDraft(sessionId);
  const draftPreview = draft
    ? { text: draft, totalLines: draft.split("\n").length }
    : undefined;
  const pendingQuestion = getPendingQuestionState(sessionId);
  const plan = getPlanPreview(sessionId) || (await store.getSessionPlanText(sessionId)) || undefined;

  if (pendingQuestion) {
    return {
      status: "active",
      chat_jid: chatJid,
      data: {
        type: "question",
        title: "Waiting for your answer...",
        chat_jid: chatJid,
        ...(turnId ? { turn_id: turnId } : {}),
        pending_question: {
          question_id: pendingQuestion.questionId,
          question: pendingQuestion.question,
          options: pendingQuestion.options,
        },
      },
      draft: draftPreview,
      plan: plan ? { text: plan } : undefined,
      thought: undefined,
    };
  }

  return {
    status: "active",
    chat_jid: chatJid,
    data: {
      type: locked ? "thinking" : "streaming",
      title: locked ? "Thinking..." : "Working...",
      chat_jid: chatJid,
      ...(turnId ? { turn_id: turnId } : {}),
    },
    draft: draftPreview,
    plan: plan ? { text: plan } : undefined,
    thought: undefined,
  };
}

export async function getQueueState(chatJid: string) {
  const sessionId = await ensureChatSession(chatJid);
  const items = await store.listQueuedFollowupItems(sessionId);
  return {
    count: items.length,
    items: items.map((item) => ({
      row_id: item.messageId,
      content: item.content,
      status: "queued" as const,
      message_id: item.messageId,
    })),
  };
}

export async function removeQueueItem(chatJid: string, rowId: number) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await removeQueuedFollowup(sessionId, rowId);
  return { status: "ok" as const, ...result };
}

export async function steerQueueItem(chatJid: string, rowId: number) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await steerQueuedFollowup(sessionId, rowId);
  return { status: "ok" as const, ...result };
}

export async function reorderQueueItems(chatJid: string, fromIndex: number, toIndex: number) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await reorderQueuedFollowups(sessionId, fromIndex, toIndex);
  return { status: "ok" as const, ...result };
}

export async function sendAgentMessage(chatJid: string, content: string, mode?: string | null) {
  const sessionId = await ensureChatSession(chatJid);
  if (mode === "steer" && (content.trim() === "/abort" || content.trim().startsWith("/abort "))) {
    await abortSessionTurn(sessionId);
    return {
      ok: true,
      ui_only: true,
      command: { status: "success", message: "Turn aborted" },
      outcome: "aborted",
    };
  }
  const { outcome, userMessageId } = await submitMessage(sessionId, content);
  const userMessage =
    userMessageId > 0 ? userPostPayload(chatJid, userMessageId, content) : undefined;
  if (outcome === "aborted") {
    return {
      ok: true,
      ui_only: true,
      command: { status: "success", message: "Turn aborted" },
      outcome: "aborted",
    };
  }
  if (mode === "queue" && outcome === "ran") {
    return { ok: true, queued: false, ran: true, user_message: userMessage };
  }
  return { ok: true, outcome, queued: outcome === "queued", user_message: userMessage };
}

export async function answerAgentQuestion(chatJid: string, questionId: string, answer: string) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await answerPendingQuestion(sessionId, questionId, answer);
  return { ok: result.ok, error: result.error };
}

export async function setAgentMode(chatJid: string, mode: "plan" | "execute") {
  const sessionId = await ensureChatSession(chatJid);
  await setTurnSessionMode(sessionId, mode);
  return { ok: true, mode };
}

export async function listSessionSubagents(chatJid: string) {
  const sessionId = await ensureChatSession(chatJid);
  const runs = await store.listSubagentRuns(sessionId, 50);
  return {
    runs: runs.map((run) => ({
      run_id: run.id,
      agent_type: run.agent_type,
      description: run.description ?? run.task,
      status: run.status,
      task: run.task,
      summary: run.summary,
      tool_count: run.tool_count,
      started_at: run.started_at,
      finished_at: run.finished_at,
      background: run.background,
    })),
  };
}

export async function getSubagentStatus(chatJid: string, runId: string) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await getSubagentResult(sessionId, runId, { verbose: true });
  return { success: !result.isError, data: JSON.parse(result.output) };
}

export async function steerSubagentForChat(chatJid: string, runId: string, message: string) {
  const sessionId = await ensureChatSession(chatJid);
  const result = await steerSubagent(sessionId, runId, message);
  return { success: !result.isError, ...(result.isError ? { error: result.output } : { data: { ok: true } }) };
}

export async function abortAgentRunForChat(chatJid: string) {
  const sessionId = await ensureChatSession(chatJid);
  await abortSessionTurn(sessionId);
  return {
    ok: true,
    status: "ok",
    ui_only: true,
    outcome: "aborted",
    command: { status: "success", message: "Turn aborted" },
  };
}

export async function stopSubagentForChat(chatJid: string, runId: string) {
  const sessionId = await ensureChatSession(chatJid);
  const { stopSubagent } = await import("./subagents/service.ts");
  return stopSubagent(sessionId, runId);
}

export async function getSubagentTranscript(chatJid: string, runId: string) {
  const sessionId = await ensureChatSession(chatJid);
  const run = await store.getSubagentRun(runId);
  if (!run || run.session_id !== sessionId) return { messages: [] };
  const messages = await store.listSubagentMessages(runId);
  return { messages };
}

export async function spawnSubagentViaApi(
  chatJid: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const sessionId = await ensureChatSession(chatJid);
  const prompt = String(body.prompt ?? body.task ?? "").trim();
  const description = String(body.description ?? prompt).trim();
  const subagentType = String(body.subagent_type ?? "general-purpose") as
    | "general-purpose"
    | "explore"
    | "plan";
  if (!prompt) return { success: false, error: "prompt required" };
  const outcome = await spawnAgent(sessionId, {
    prompt,
    description,
    subagentType,
    maxTurns: typeof body.max_turns === "number" ? body.max_turns : undefined,
    runInBackground: Boolean(body.run_in_background),
    resume: typeof body.resume === "string" ? body.resume : undefined,
  });
  return { success: true, data: outcome };
}

export async function listUserSkills(userId: string) {
  const skills = await listUserSkillsForApi(userId);
  return { skills };
}

export async function installSkillForUser(
  userId: string,
  body: { name: string; description?: string; content: string },
) {
  const name = body.name.trim();
  const content = body.content.trim();
  if (!name || !content) throw new Error("name and content required");
  await installUserSkill(userId, {
    name,
    description: body.description ?? "",
    content,
  });
  return { ok: true };
}

export async function removeUserSkill(userId: string, name: string) {
  const deleted = await deleteUserSkill(userId, name);
  if (!deleted) throw new Error(`unknown skill: ${name}`);
  return { ok: true };
}

export async function listSessions(userId?: string, options?: store.ListSessionsOptions) {
  return store.listSessions(userId, options);
}

export function sessionToBranchChat(session: {
  id: string;
  title: string;
  sandbox_id?: string | null;
  archived_at?: string | null;
}) {
  const title = session.title?.trim() || session.id;
  return {
    chat_jid: session.id,
    root_chat_jid: session.id,
    agent_name: title,
    title,
    sandbox_id: session.sandbox_id ?? null,
    is_root: true,
    archived_at: session.archived_at ?? null,
  };
}

async function assertSessionCanMutate(
  sessionId: string,
  userId: string,
  action: "archive" | "purge",
): Promise<store.SessionRow> {
  const session = await store.getSessionForUser(sessionId, userId);
  if (!session) throw new Error(`Unknown chat branch: ${sessionId}`);
  const locked = await store.isSessionLocked(sessionId);
  const inflight = getInflightTurn(sessionId);
  if (locked || inflight) {
    throw new Error(
      action === "purge"
        ? "Cannot permanently delete a branch while it is active."
        : "Cannot archive a session while it is active.",
    );
  }
  return session;
}

export async function getChatBranches(options?: { includeArchived?: boolean; userId?: string }) {
  const sessions = await listSessions(options?.userId, { includeArchived: options?.includeArchived });
  return { chats: sessions.map(sessionToBranchChat) };
}

export async function getActiveChatAgents(userId?: string) {
  const sessions = await listSessions(userId);
  return { chats: sessions.map(sessionToBranchChat) };
}

export async function pruneChatBranch(chatJid: string, userId: string) {
  const sessionId = chatJidToSessionId(chatJid);
  const session = await assertSessionCanMutate(sessionId, userId, "archive");
  if (session.archived_at) {
    return { status: "ok", branch: sessionToBranchChat(session) };
  }
  const archived = await store.archiveSession(sessionId, userId);
  return { status: "ok", branch: sessionToBranchChat(archived) };
}

export async function purgeChatBranch(chatJid: string, userId: string) {
  const sessionId = chatJidToSessionId(chatJid);
  await assertSessionCanMutate(sessionId, userId, "purge");
  const branch = await store.purgeSession(sessionId, userId);
  return { status: "ok", branch: sessionToBranchChat(branch), removedSessionArtifacts: [] };
}

export async function restoreChatBranch(
  chatJid: string,
  userId: string,
  agentName?: string,
) {
  const sessionId = chatJidToSessionId(chatJid);
  const existing = await store.getSessionForUser(sessionId, userId);
  if (!existing) throw new Error(`Unknown chat branch: ${sessionId}`);
  const restored = await store.restoreSession(sessionId, userId, agentName);
  return { status: "ok", branch: sessionToBranchChat(restored) };
}

export async function renameChatBranch(chatJid: string, userId: string, agentName: string) {
  const sessionId = chatJidToSessionId(chatJid);
  const renamed = await store.renameSessionTitle(sessionId, agentName, userId);
  return { status: "ok", branch: sessionToBranchChat(renamed) };
}

export function getAgentsRoster() {
  return {
    agents: [
      {
        id: "default",
        name: "PiClaw",
        description: "PiClaw agent",
        status: "running",
        actions: [],
        avatar_url: null,
        model: config.openaiModel,
        chat_jid: null,
      },
    ],
    user: {
      name: "User",
      avatar_url: null,
      avatar_background: null,
    },
  };
}

export async function createUntitledSession(userId: string = DEFAULT_USER_ID) {
  const chatJid = `web:${crypto.randomUUID()}`;
  await store.createSession(chatJid, UNTITLED_SESSION_TITLE, userId);
  const session = await store.getSessionForUser(chatJid, userId);
  if (!session) throw new Error("Failed to create chat session");
  return { chatJid, branch: sessionToBranchChat(session) };
}

export async function createRootChatSession(userId: string = DEFAULT_USER_ID) {
  const { chatJid, branch } = await createUntitledSession(userId);
  return {
    branch: {
      chat_jid: chatJid,
      root_chat_jid: chatJid,
      agent_name: branch.agent_name,
      title: branch.title,
    },
  };
}

export async function sendAgentMessageWithOptionalCreate(
  chatJid: string | null | undefined,
  content: string,
  mode: string | null | undefined,
  userId: string,
) {
  let resolvedChatJid = typeof chatJid === "string" ? chatJid.trim() : "";
  let created = false;
  let branch: ReturnType<typeof sessionToBranchChat> | undefined;

  if (resolvedChatJid) {
    await requireSessionAccess(resolvedChatJid, userId);
  } else {
    const createdSession = await createUntitledSession(userId);
    resolvedChatJid = createdSession.chatJid;
    branch = createdSession.branch;
    created = true;
  }

  const result = await sendAgentMessage(resolvedChatJid, content, mode);
  if (!branch) {
    const session = await store.getSessionForUser(resolvedChatJid, userId);
    if (session) branch = sessionToBranchChat(session);
  }

  return {
    ...result,
    chat_jid: resolvedChatJid,
    created,
    branch,
  };
}

export function getTerminalSessionInfo(chatJid: string) {
  const jid = chatJidToSessionId(chatJid);
  return {
    enabled: config.sandboxEnabled,
    transport: "websocket",
    ws_path: `/terminal/ws?chat_jid=${encodeURIComponent(jid)}`,
    cwd: "/workspace",
    shell: "/bin/bash",
    active: false,
    connected_clients: 0,
  };
}

export function createTerminalHandoff() {
  return { handoff: { token: "cloud-noop" } };
}
