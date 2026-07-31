/**
 * HTTP surface — native session API + runtime/web compatibility shim.
 */
import { mapInternalToSse, type SseScope } from "@piclaw-cloud/shared/sse-events";
import * as store from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";
import { AuthError, requireSessionAccess, resolveRequestUser } from "./auth.ts";
import { config } from "./config.ts";
import { applyCors, handleCorsPreflight } from "./cors.ts";
import { QuotaExceededError } from "./quota.ts";
import { subscribe, type SessionEvent } from "./events.ts";
import { serveStaticRequest } from "./static.ts";
import { submitMessage, sweepInflight } from "./turn.ts";
import { getContextUsage } from "./agent-run-state.ts";
import { getKernelRuntime } from "./kernel/runtime.ts";
import { handleWorkspaceRoutes } from "./workspace/routes.ts";
import { handleMediaRoutes } from "./media/routes.ts";
import { handleWebPushRoutes } from "./push/routes.ts";
import {
  handleScheduledTasksAction,
  handleScheduledTasksList,
} from "./scheduled-tasks/handlers.ts";
import { handleInternalScheduledTaskExecute } from "./scheduled-tasks/run-handler.ts";
import {
  agentResponseSsePayload,
  answerAgentQuestion,
  abortAgentRunForChat,
  chatJidToSessionId,
  createRootChatSession,
  createTerminalHandoff,
  ensureChatSession,
  getActiveChatAgents,
  getAgentStatus,
  getAgentsRoster,
  getChatBranches,
  getQueueState,
  getSubagentStatus,
  getSubagentTranscript,
  getTerminalSessionInfo,
  getTimeline,
  listSessionSubagents,
  installSkillForUser,
  listUserSkills,
  pruneChatBranch,
  purgeChatBranch,
  removeUserSkill,
  renameChatBranch,
  restoreChatBranch,
  removeQueueItem,
  reorderQueueItems,
  sendAgentMessage,
  sendAgentMessageWithOptionalCreate,
  setAgentMode,
  spawnSubagentViaApi,
  steerSubagentForChat,
  steerQueueItem,
  stopSubagentForChat,
  userPostPayload,
} from "./web-adapter.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


function readRequestChatJid(url: URL): string | null {
  const raw = url.searchParams.get("chat_jid");
  return raw && raw.trim() ? raw.trim() : null;
}

function idleAgentStatusPayload(chatJid: string | null = null) {
  return {
    status: "idle",
    chat_jid: chatJid,
    data: { type: "done", title: "Idle", chat_jid: chatJid },
  };
}

function emptyQueueState() {
  return { count: 0, items: [] };
}

function noopSseResponse(): Response {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("connected", { chat_jid: null, chatJid: null, replica: config.replicaId });
      heartbeat = setInterval(() => {
        try {
          send("heartbeat", { at: Date.now() });
        } catch {
          // closed
        }
      }, 15000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
function sseResponse(sessionId: string, chatJid?: string): Response {
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const jid = chatJid ?? sessionId;
      send("connected", { chat_jid: jid, chatJid: jid, replica: config.replicaId });
      let activeTurnId: string | null = null;
      cleanup = subscribe(sessionId, (event: SessionEvent) => {
        if (event.type === "turn_started") {
          activeTurnId = String(event.messageId);
        }

        if (event.type === "message" && event.role === "user") {
          send("new_post", userPostPayload(jid, event.id, event.content));
          return;
        }

        if (event.type === "message" && event.role === "assistant") {
          send("agent_response", agentResponseSsePayload(jid, event.id, event.content, event.recovery));
          return;
        }

        const scope: SseScope = { chatJid: jid, turnId: activeTurnId };
        const envelope = mapInternalToSse(scope, event);
        if (envelope) {
          send(envelope.event, envelope.data);
        }

        if (event.type === "turn_done" || event.type === "turn_failed" || event.type === "turn_aborted") {
          activeTurnId = null;
        }
      });
      heartbeat = setInterval(() => {
        try {
          send("heartbeat", { at: Date.now() });
        } catch {
          // closed
        }
      }, 15000);
    },
    cancel() {
      cleanup?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

type RequestContext = { userId: string };

async function withAuth(req: Request, handler: (ctx: RequestContext) => Promise<Response>): Promise<Response> {
  try {
    const userId = await resolveRequestUser(req);
    await store.setUserContext(userId);
    return applyCors(req, await handler({ userId }));
  } catch (error) {
    if (error instanceof AuthError) {
      return applyCors(req, json({ error: error.message }, 401));
    }
    throw error;
  }
}

export async function bootstrapSchema(): Promise<void> {
  await applyMigrations();
}

export function startServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.port,
    idleTimeout: 0,
    async fetch(req, server) {
      const preflight = handleCorsPreflight(req);
      if (preflight) return preflight;
      const respond = (response: Response) => applyCors(req, response);

      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);

      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return respond(json({ ok: true, replica: config.replicaId, sandbox: config.sandboxEnabled }));
        }

        // ── Web UI compatibility ──────────────────────────────────────

        if (req.method === "GET" && url.pathname === "/sse/stream") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(noopSseResponse());
          const sessionId = await ensureChatSession(chatJid);
          return respond(sseResponse(sessionId, chatJid));
        }

        if (req.method === "GET" && url.pathname === "/timeline") {
          const chatJid = readRequestChatJid(url);
          const limit = Number(url.searchParams.get("limit") || 10);
          if (!chatJid) return respond(json({ posts: [], limit, has_more: false }));
          const beforeRaw = url.searchParams.get("before_id");
          const before = beforeRaw ? Number(beforeRaw) : null;
          return respond(json(await getTimeline(chatJid, limit, before)));
        }

        if (req.method === "GET" && url.pathname === "/agent/status") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json(idleAgentStatusPayload()));
          return respond(json(await getAgentStatus(chatJid)));
        }

        if (req.method === "GET" && url.pathname === "/agent/queue-state") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json(emptyQueueState()));
          return respond(json(await getQueueState(chatJid)));
        }

        if (req.method === "GET" && url.pathname === "/agent/roster") {
          return respond(json(getAgentsRoster()));
        }

        if (req.method === "GET" && url.pathname === "/agent/active-chats") {
          return respond(json(await getActiveChatAgents()));
        }

        if (req.method === "GET" && url.pathname === "/agent/branches") {
          return withAuth(req, async ({ userId }) => {
            const includeArchived = url.searchParams.get("include_archived") === "1";
            return respond(json(await getChatBranches({ includeArchived, userId })));
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-prune") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            if (!chatJid) return respond(json({ error: "Missing chat_jid" }, 400));
            try {
              return respond(json(await pruneChatBranch(chatJid, userId)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error || "Failed to prune branch.");
              return respond(json({ error: message || "Failed to prune branch." }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-purge") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            if (!chatJid) return respond(json({ error: "Missing chat_jid" }, 400));
            try {
              return respond(json(await purgeChatBranch(chatJid, userId)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error || "Failed to permanently delete archived branch.");
              return respond(json({ error: message || "Failed to permanently delete archived branch." }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-restore") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            if (!chatJid) return respond(json({ error: "Missing chat_jid" }, 400));
            const agentName = typeof body.agent_name === "string" ? body.agent_name : undefined;
            try {
              return respond(json(await restoreChatBranch(chatJid, userId, agentName)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error || "Failed to restore branch.");
              return respond(json({ error: message || "Failed to restore branch." }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-rename") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            const agentName = typeof body.agent_name === "string" ? body.agent_name.trim() : "";
            if (!chatJid) return respond(json({ error: "Missing chat_jid" }, 400));
            if (!agentName) return respond(json({ error: "Missing agent_name" }, 400));
            try {
              return respond(json(await renameChatBranch(chatJid, userId, agentName)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error || "Failed to rename branch.");
              return respond(json({ error: message || "Failed to rename branch." }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-fork") {
          return respond(json({ error: "Branch fork is not available in cloud mode." }, 501));
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-merge-parent") {
          return respond(json({ error: "Branch merge is not available in cloud mode." }, 501));
        }

        if (req.method === "POST" && url.pathname === "/agent/root-session") {
          return withAuth(req, async ({ userId }) => respond(json(await createRootChatSession(userId))));
        }

        if (req.method === "POST" && url.pathname === "/agent/ui-state") {
          return respond(json({ ok: true }));
        }

        if (req.method === "POST" && url.pathname === "/agent/question/answer") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const questionId = String(body.question_id ?? body.questionId ?? "");
          const answer = String(body.answer ?? body.content ?? "");
          if (!questionId || !answer) return respond(json({ error: "question_id and answer required" }, 400));
          return respond(json(await answerAgentQuestion(chatJid, questionId, answer)));
        }

        if (req.method === "POST" && url.pathname === "/agent/mode") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const mode = body.mode === "plan" ? "plan" : "execute";
          return respond(json(await setAgentMode(chatJid, mode)));
        }

        if (req.method === "GET" && url.pathname === "/agent/subagents") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ runs: [] }));
          return respond(json(await listSessionSubagents(chatJid)));
        }

        const mediaResponse = await handleMediaRoutes(req, url.pathname);
        if (mediaResponse) return respond(mediaResponse);

        if (req.method === "GET" && url.pathname === "/agent/scheduled-tasks") {
          return respond(await handleScheduledTasksList(req, url));
        }

        if (req.method === "POST" && url.pathname === "/agent/scheduled-tasks/action") {
          return respond(await handleScheduledTasksAction(req));
        }

        if (req.method === "POST" && url.pathname === "/internal/scheduled-tasks/execute") {
          return respond(await handleInternalScheduledTaskExecute(req));
        }

        if (req.method === "GET" && url.pathname.startsWith("/agent/settings/")) {
          return respond(json({}));
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-steer") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const rowId = Number(body.row_id);
          if (!Number.isFinite(rowId)) return respond(json({ error: "row_id required" }, 400));
          return respond(json(await steerQueueItem(chatJid, rowId)));
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-remove") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const rowId = Number(body.row_id);
          if (!Number.isFinite(rowId)) return respond(json({ error: "row_id required" }, 400));
          return respond(json(await removeQueueItem(chatJid, rowId)));
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-reorder") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const fromIndex = Number(body.from_index);
          const toIndex = Number(body.to_index);
          if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
            return respond(json({ error: "from_index and to_index required" }, 400));
          }
          return respond(json(await reorderQueueItems(chatJid, fromIndex, toIndex)));
        }

        if (req.method === "GET" && url.pathname === "/agent/commands") {
          return respond(json({ commands: [] }));
        }

        if (req.method === "GET" && url.pathname === "/agent/models") {
          return respond(json({ models: [{ id: config.openaiModel, label: config.openaiModel }], current: config.openaiModel }));
        }

        if (req.method === "GET" && url.pathname === "/agent/context") {
          const chatJid = readRequestChatJid(url);
          const kernel = getKernelRuntime();
          const fallbackWindow = kernel?.model.contextWindow ?? null;
          if (!chatJid) {
            return respond(json({ tokens: null, context_window: fallbackWindow, percent: null }));
          }
          const usage = getContextUsage(chatJidToSessionId(chatJid));
          if (!usage) {
            return respond(json({ tokens: null, context_window: fallbackWindow, percent: null }));
          }
          return respond(json({
            tokens: usage.tokens,
            context_window: usage.contextWindow,
            percent: usage.percent,
          }));
        }

        if (req.method === "GET" && url.pathname === "/agent/autoresearch/status") {
          return respond(json({ content: [] }));
        }

        if (req.method === "POST" && url.pathname.startsWith("/agent/autoresearch/")) {
          return respond(json({ ok: true }));
        }

        if (req.method === "GET" && url.pathname === "/agent/addons/web-entries") {
          return respond(json({ entries: [] }));
        }

        const pushResponse = await handleWebPushRoutes(req, url.pathname);
        if (pushResponse) return respond(pushResponse);

        if (req.method === "GET" && url.pathname === "/terminal/session") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) {
            return respond(json({
              enabled: config.sandboxEnabled,
              transport: "websocket",
              ws_path: "/terminal/ws",
              cwd: "/workspace",
              shell: "/bin/bash",
              active: false,
              connected_clients: 0,
            }));
          }
          return respond(json(getTerminalSessionInfo(chatJid)));
        }

        if (req.method === "POST" && url.pathname === "/terminal/handoff") {
          return respond(json(createTerminalHandoff()));
        }

        if (req.method === "POST" && url.pathname === "/agent/runs/abort") {
          return withAuth(req, async () => {
            const chatJid = readRequestChatJid(url);
            if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
            return respond(json(await abortAgentRunForChat(chatJid)));
          });
        }

        if (req.method === "POST" && parts[0] === "agent" && parts[1] && parts[2] === "message") {
          return withAuth(req, async ({ userId }) => {
            const chatJid = readRequestChatJid(url);
            const body = await readJson(req);
            const content = String(body.content || "");
            if (!content) return respond(json({ error: "content required" }, 400));
            const mode = typeof body.mode === "string" ? body.mode : null;
            try {
              const result = await sendAgentMessageWithOptionalCreate(chatJid, content, mode, userId);
              return respond(json(result));
            } catch (error) {
              if (error instanceof QuotaExceededError) {
                return respond(json({ ok: false, ...error.toJson() }, 429));
              }
              throw error;
            }
          });
        }

        if (req.method === "GET" && url.pathname === "/terminal/ws") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const sessionId = chatJidToSessionId(chatJid);
          const upgraded = server.upgrade(req, { data: { sessionId, chatJid } });
          if (upgraded) return undefined as unknown as Response;
          return respond(json({ error: "websocket upgrade failed" }, 400));
        }

        if (req.method === "GET" && url.pathname === "/skills") {
          return withAuth(req, async ({ userId }) => json(await listUserSkills(userId)));
        }

        if (req.method === "POST" && url.pathname === "/skills") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            try {
              return respond(json(await installSkillForUser(userId, {
                name: String(body.name ?? ""),
                description: typeof body.description === "string" ? body.description : "",
                content: String(body.content ?? ""),
              })));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ error: message }, 400));
            }
          });
        }

        if (req.method === "DELETE" && parts[0] === "skills" && parts[1]) {
          return withAuth(req, async ({ userId }) => {
            try {
              return respond(json(await removeUserSkill(userId, decodeURIComponent(parts[1]!))));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ error: message }, 404));
            }
          });
        }

        // ── Native session API ────────────────────────────────────────

        if (req.method === "POST" && url.pathname === "/sessions") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
            const title = typeof body.title === "string" ? body.title : "";
            await store.createSession(id, title, userId);
            return respond(json({ id }));
          });
        }

        if (parts[0] === "sessions" && parts[1]) {
          const sessionId = parts[1];

          if (req.method === "GET" && parts.length === 2) {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const session = await store.getSession(sessionId);
              if (!session) return respond(json({ error: "unknown session" }, 404));
              return respond(json({ session }));
            });
          }

          if (req.method === "GET" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return respond(json({ messages: await store.listMessages(sessionId) }));
            });
          }

          if (req.method === "POST" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const body = await readJson(req);
              const content = String(body.content || "");
              if (!content) return respond(json({ error: "content required" }, 400));
              if (!(await store.getSession(sessionId))) return respond(json({ error: "unknown session" }, 404));

              const outcomePromise = submitMessage(sessionId, content);
              if (url.searchParams.get("wait") === "1") {
                const result = await outcomePromise;
                return respond(json({ outcome: result.outcome, user_message_id: result.userMessageId, replica: config.replicaId }));
              }
              const result = await Promise.race([
                outcomePromise.catch(() => ({ outcome: "ran" as const, userMessageId: 0 })),
                Bun.sleep(120).then(() => ({ outcome: "ran" as const, userMessageId: 0 })),
              ]);
              outcomePromise.catch((error) => {
                console.error(`[${config.replicaId}] turn failed:`, error);
              });
              return respond(json({ outcome: result.outcome, user_message_id: result.userMessageId, replica: config.replicaId }));
            });
          }

          if (req.method === "GET" && parts[2] === "stream") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return respond(sseResponse(sessionId));
            });
          }

          if (req.method === "GET" && parts[2] === "subagents") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return respond(json({ runs: await store.listSubagentRuns(sessionId) }));
            });
          }

          if (req.method === "POST" && parts[2] === "subagents") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const body = await readJson(req);
              const result = await spawnSubagentViaApi(sessionId, body);
              if (!result.success) return respond(json({ success: false, error: result.error }, 400));
              return respond(json({ success: true, data: result.data }));
            });
          }


          if (req.method === "GET" && parts[2] === "cursor") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return respond(json({
                cursor: await store.getCursor(sessionId),
                queued: await store.getQueuedFollowups(sessionId),
                locked: await store.isSessionLocked(sessionId),
              }));
            });
          }
        }

        const workspaceResponse = await handleWorkspaceRoutes(req, url.pathname);
        if (workspaceResponse) return respond(workspaceResponse);

        if (parts[0] === "subagents" && parts[1]) {
          const runId = parts[1];
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));

          if (req.method === "GET" && parts.length === 2) {
            return respond(json(await getSubagentStatus(chatJid, runId)));
          }

          if (req.method === "GET" && parts[2] === "messages") {
            return respond(json(await getSubagentTranscript(chatJid, runId)));
          }

          if (req.method === "POST" && parts[2] === "steer") {
            const body = await readJson(req);
            const message = String(body.message ?? body.content ?? "");
            if (!message) return respond(json({ success: false, error: "message required" }, 400));
            return respond(json(await steerSubagentForChat(chatJid, runId, message)));
          }

          if (req.method === "POST" && parts[2] === "stop") {
            return respond(json(await stopSubagentForChat(chatJid, runId)));
          }
        }

        const staticResponse = serveStaticRequest(req);
        if (staticResponse) return respond(staticResponse);

        return respond(json({ error: "not found" }, 404));
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return respond(json(error.toJson(), 429));
        }
        if (error instanceof AuthError) {
          return respond(json({ error: error.message }, 401));
        }
        const message = error instanceof Error ? error.message : String(error);
        return respond(json({ error: message }, 500));
      }
    },
    websocket: {
      async open(ws) {
        const data = ws.data as {
          sessionId: string;
          chatJid: string;
          sandbox?: Awaited<ReturnType<typeof import("./sandbox/session.ts").ensureSandbox>>;
          terminal?: { pid: number; kill?: () => Promise<boolean> };
        };
        try {
          const { ensureSandbox } = await import("./sandbox/session.ts");
          const sandbox = await ensureSandbox(data.sessionId);
          data.sandbox = sandbox;
          const terminal = await sandbox.pty.create({
            cols: 80,
            rows: 24,
            timeoutMs: 120_000,
            onData: (chunk) => {
              const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              try {
                ws.send(text);
              } catch {
                // client gone
              }
            },
          });
          data.terminal = terminal;
          ws.send("\r\n[connected]\r\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ws.send(`\r\n[terminal error] ${message}\r\n`);
          ws.close();
        }
      },
      message(ws, message) {
        const data = ws.data as { sandbox?: { pty: { sendInput: (pid: number, bytes: Uint8Array) => Promise<void> } }; terminal?: { pid: number } };
        if (!data.sandbox || !data.terminal) return;
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        void data.sandbox.pty.sendInput(data.terminal.pid, new TextEncoder().encode(text));
      },
      close(ws) {
        const data = ws.data as { terminal?: { kill?: () => Promise<boolean> } };
        void data.terminal?.kill?.().catch(() => {});
      },
    },
  });
}

export function startRecoverySweep(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    sweepInflight().catch((error) => {
      console.error(`[${config.replicaId}] sweep error:`, error);
    });
  }, config.sweepIntervalMs);
}
