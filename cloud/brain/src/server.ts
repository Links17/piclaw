/**
 * HTTP surface — native session API + runtime/web compatibility shim.
 */
import { mapInternalToWeb } from "@piclaw-cloud/shared/sse-events";
import * as store from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";
import { AuthError, requireSessionAccess, resolveRequestUser } from "./auth.ts";
import { config } from "./config.ts";
import { QuotaExceededError } from "./quota.ts";
import { subscribe, type SessionEvent } from "./events.ts";
import { serveStaticRequest } from "./static.ts";
import { submitMessage, sweepInflight } from "./turn.ts";
import { handleWorkspaceRoutes } from "./workspace/routes.ts";
import {
  agentResponseSsePayload,
  chatJidToSessionId,
  createRootChatSession,
  createTerminalHandoff,
  ensureChatSession,
  getActiveChatAgents,
  getAgentStatus,
  getAgentsRoster,
  getChatBranches,
  getQueueState,
  getTerminalSessionInfo,
  getTimeline,
  sendAgentMessage,
} from "./web-adapter.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
      send("connected", { chatJid: jid, replica: config.replicaId });
      cleanup = subscribe(sessionId, (event: SessionEvent) => {
        if (event.type === "message" && event.role === "assistant") {
          send("agent_response", agentResponseSsePayload(jid, event.id, event.content, event.recovery));
        }
        const mapped = mapInternalToWeb(sessionId, event);
        if (mapped && mapped.type !== "heartbeat") {
          send(mapped.type, mapped);
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
    return await handler({ userId });
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.message }, 401);
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
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);

      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return json({ ok: true, replica: config.replicaId, sandbox: config.sandboxEnabled });
        }

        // ── Web UI compatibility ──────────────────────────────────────

        if (req.method === "GET" && url.pathname === "/sse/stream") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          const sessionId = await ensureChatSession(chatJid);
          return sseResponse(sessionId, chatJid);
        }

        if (req.method === "GET" && url.pathname === "/timeline") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          const limit = Number(url.searchParams.get("limit") || 10);
          const beforeRaw = url.searchParams.get("before_id");
          const before = beforeRaw ? Number(beforeRaw) : null;
          return json(await getTimeline(chatJid, limit, before));
        }

        if (req.method === "GET" && url.pathname === "/agent/status") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          return json(await getAgentStatus(chatJid));
        }

        if (req.method === "GET" && url.pathname === "/agent/queue-state") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          return json(await getQueueState(chatJid));
        }

        if (req.method === "GET" && url.pathname === "/agent/roster") {
          return json(getAgentsRoster());
        }

        if (req.method === "GET" && url.pathname === "/agent/active-chats") {
          return json(await getActiveChatAgents());
        }

        if (req.method === "GET" && url.pathname === "/agent/branches") {
          return withAuth(req, async ({ userId }) => {
            const sessions = await store.listSessions(userId);
            return json({
              chats: sessions.map((session) => ({
                chat_jid: session.id,
                root_chat_jid: session.id,
                agent_name: session.title?.trim() || session.id,
                title: session.title?.trim() || session.id,
                is_root: true,
              })),
            });
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/root-session") {
          const body = await readJson(req);
          const agentName = typeof body.agent_name === "string" ? body.agent_name : "Chat";
          return json(await createRootChatSession(agentName));
        }

        if (req.method === "POST" && url.pathname === "/agent/ui-state") {
          return json({ ok: true });
        }

        if (req.method === "GET" && url.pathname.startsWith("/agent/settings/")) {
          return json({});
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-steer") {
          return json({ removed: false, queued: "steer" });
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-remove") {
          return json({ removed: false });
        }

        if (req.method === "GET" && url.pathname === "/agent/commands") {
          return json({ commands: [] });
        }

        if (req.method === "GET" && url.pathname === "/agent/models") {
          return json({ models: [{ id: config.openaiModel, label: config.openaiModel }], current: config.openaiModel });
        }

        if (req.method === "GET" && url.pathname === "/agent/context") {
          return json({ tokens: null, context_window: null, percent: null });
        }

        if (req.method === "GET" && url.pathname === "/terminal/session") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          return json(getTerminalSessionInfo(chatJid));
        }

        if (req.method === "POST" && url.pathname === "/terminal/handoff") {
          return json(createTerminalHandoff());
        }

        if (req.method === "POST" && parts[0] === "agent" && parts[1] && parts[2] === "message") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          const body = await readJson(req);
          const content = String(body.content || "");
          if (!content) return json({ error: "content required" }, 400);
          const mode = typeof body.mode === "string" ? body.mode : null;
          try {
            const result = await sendAgentMessage(chatJid, content, mode);
            return json(result);
          } catch (error) {
            if (error instanceof QuotaExceededError) {
              return json({ ok: false, ...error.toJson() }, 429);
            }
            throw error;
          }
        }

        if (req.method === "GET" && url.pathname === "/terminal/ws") {
          const chatJid = url.searchParams.get("chat_jid") || config.defaultChatJid;
          const sessionId = chatJidToSessionId(chatJid);
          const upgraded = server.upgrade(req, { data: { sessionId, chatJid } });
          if (upgraded) return undefined as unknown as Response;
          return json({ error: "websocket upgrade failed" }, 400);
        }

        // ── Native session API ────────────────────────────────────────

        if (req.method === "POST" && url.pathname === "/sessions") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
            const title = typeof body.title === "string" ? body.title : "";
            await store.createSession(id, title, userId);
            return json({ id });
          });
        }

        if (parts[0] === "sessions" && parts[1]) {
          const sessionId = parts[1];

          if (req.method === "GET" && parts.length === 2) {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const session = await store.getSession(sessionId);
              if (!session) return json({ error: "unknown session" }, 404);
              return json({ session });
            });
          }

          if (req.method === "GET" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return json({ messages: await store.listMessages(sessionId) });
            });
          }

          if (req.method === "POST" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const body = await readJson(req);
              const content = String(body.content || "");
              if (!content) return json({ error: "content required" }, 400);
              if (!(await store.getSession(sessionId))) return json({ error: "unknown session" }, 404);

              const outcomePromise = submitMessage(sessionId, content);
              if (url.searchParams.get("wait") === "1") {
                return json({ outcome: await outcomePromise, replica: config.replicaId });
              }
              const outcome = await Promise.race([
                outcomePromise.catch(() => "ran" as const),
                Bun.sleep(120).then(() => "ran" as const),
              ]);
              outcomePromise.catch((error) => {
                console.error(`[${config.replicaId}] turn failed:`, error);
              });
              return json({ outcome, replica: config.replicaId });
            });
          }

          if (req.method === "GET" && parts[2] === "stream") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return sseResponse(sessionId);
            });
          }

          if (req.method === "GET" && parts[2] === "subagents") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return json({ runs: await store.listSubagentRuns(sessionId) });
            });
          }

          if (req.method === "GET" && parts[2] === "cursor") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return json({
                cursor: await store.getCursor(sessionId),
                queued: await store.getQueuedFollowups(sessionId),
                locked: await store.isSessionLocked(sessionId),
              });
            });
          }
        }

        const workspaceResponse = await handleWorkspaceRoutes(req, url.pathname);
        if (workspaceResponse) return workspaceResponse;

        const staticResponse = serveStaticRequest(req);
        if (staticResponse) return staticResponse;

        return json({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return json(error.toJson(), 429);
        }
        if (error instanceof AuthError) {
          return json({ error: error.message }, 401);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
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
