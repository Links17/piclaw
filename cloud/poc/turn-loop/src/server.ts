/**
 * HTTP surface for one brain replica.
 *
 * POST /sessions                     {id?, title?} → create session
 * GET  /sessions/:id/messages        message history (durable truth)
 * POST /sessions/:id/messages        {content} → run turn or queue follow-up
 * GET  /sessions/:id/stream          SSE bridged from Redis pub/sub
 * GET  /sessions/:id/cursor          cursor row (debug)
 * GET  /health
 */
import { config } from "./config.ts";
import { subscribe, type SessionEvent } from "./events.ts";
import * as store from "./store.ts";
import { submitMessage } from "./turn.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(sessionId: string): Response {
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("connected", { replica: config.replicaId });
      cleanup = subscribe(sessionId, (event: SessionEvent) => {
        send(event.type, event);
      });
      heartbeat = setInterval(() => {
        try {
          send("heartbeat", { at: Date.now() });
        } catch {
          // controller already closed; cancel() handles cleanup
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

export function startServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);

      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return json({ ok: true, replica: config.replicaId });
        }

        if (req.method === "POST" && url.pathname === "/sessions") {
          const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string };
          const id = body.id || crypto.randomUUID();
          await store.createSession(id, body.title || "");
          return json({ id });
        }

        if (parts[0] === "sessions" && parts[1]) {
          const sessionId = parts[1];

          if (req.method === "GET" && parts[2] === "messages") {
            return json({ messages: await store.listMessages(sessionId) });
          }

          if (req.method === "POST" && parts[2] === "messages") {
            const body = (await req.json().catch(() => ({}))) as { content?: string };
            if (!body.content) return json({ error: "content required" }, 400);
            if (!(await store.getSession(sessionId))) return json({ error: "unknown session" }, 404);

            // Fire the turn asynchronously; the submit response only reports
            // whether it ran immediately or was deferred.
            const outcomePromise = submitMessage(sessionId, body.content);
            if (url.searchParams.get("wait") === "1") {
              return json({ outcome: await outcomePromise, replica: config.replicaId });
            }
            // Async path still needs a quick queued/ran signal: race a short
            // window in which lock contention resolves.
            const outcome = await Promise.race([
              outcomePromise.catch(() => "ran" as const),
              Bun.sleep(120).then(() => "ran" as const),
            ]);
            outcomePromise.catch((error) => {
              console.error(`[${config.replicaId}] turn failed:`, error);
            });
            return json({ outcome, replica: config.replicaId });
          }

          if (req.method === "GET" && parts[2] === "stream") {
            return sseResponse(sessionId);
          }

          if (req.method === "GET" && parts[2] === "cursor") {
            return json({
              cursor: await store.getCursor(sessionId),
              queued: await store.getQueuedFollowups(sessionId),
              locked: await store.isSessionLocked(sessionId),
            });
          }
        }

        return json({ error: "not found" }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
      }
    },
  });
}
