/**
 * HTTP surface — native session API + runtime/web compatibility shim.
 */
import { mapInternalToSse, type SseScope } from "@piclaw-cloud/shared/sse-events";
import { isPlaceholderSchedulerServiceKey } from "@piclaw-cloud/shared/cloud-config";
import * as store from "@piclaw-cloud/store";
import { applyMigrations } from "@piclaw-cloud/store/db";
import { AuthError, requireSessionAccess, resolveRequestUser } from "./auth.ts";
import { config } from "./config.ts";
import { applyCors, handleCorsPreflight } from "./cors.ts";
import { QuotaExceededError } from "./quota.ts";
import { publish, subscribe, type SessionEvent } from "./events.ts";
import { serveStaticRequest } from "./static.ts";
import { submitMessage, sweepInflight } from "./turn.ts";
import { assertSidePromptQuota, createSidePromptAbortController, runSidePrompt } from "./side-prompt.ts";
import { getContextUsage } from "./agent-run-state.ts";
import {
  buildContextUsagePayload,
  buildEstimatedContextSnapshot,
  isContextSnapshotFresh,
  resolveContextSnapshot,
} from "./context-usage.ts";
import {
  beginOperation,
  beginOperationIfAccepting,
  drainingResponse,
  getActiveOperationCounts,
  getActiveRequestCount,
  isDraining,
} from "./operations.ts";
import { resolveSessionKernelModel } from "./kernel/resolve-model.ts";
import { rowsToAgentMessages } from "./kernel/message-map.ts";
import { hydrateWithCompaction } from "./kernel/smart-compaction.ts";
import { handleWorkspaceRoutes } from "./workspace/routes.ts";
import { handleMediaRoutes } from "./media/routes.ts";
import { handleWebPushRoutes } from "./push/routes.ts";
import { handleSessionRecordingRoutes } from "./recordings/routes.ts";
import { handleAddonRoutes } from "./addons/routes.ts";
import { handleGeneralSettingsRoute, handleCompactionSettingsRoute, handleWorkspaceSettingsRoute, handleModelsRoute } from "./models/routes.ts";
import { handleKeychainRoutes } from "./keychain/routes.ts";
import { getSettingsData } from "./settings/data.ts";
import { buildAgentCommandList } from "./commands/service.ts";
import { forwardTerminalClientMessage } from "./terminal-protocol.ts";
import { attachTerminal } from "./terminal-session.ts";
import { getSessionTreeForChat } from "./session-tree/service.ts";
import { createForkedChatBranch, mergeChatBranchIntoParent } from "./branch-lineage.ts";
import { readSystemMetrics } from "./system-metrics/sampler.ts";
import {
  handleScheduledTasksAction,
  handleScheduledTasksList,
} from "./scheduled-tasks/handlers.ts";
import { handleInternalScheduledTaskExecute } from "./scheduled-tasks/run-handler.ts";
import {
  dismissAutoresearch,
  getAutoresearchStatus,
  startAutoresearch,
  stopAutoresearch,
} from "./autoresearch/service.ts";
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
  deleteChatBranch,
  removeUserSkill,
  renameChatBranch,
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

const terminalSockets = new Set<{ send(data: string): void; close(code?: number, reason?: string): void }>();
let activeSseConnections = 0;

export async function closeTerminalSocketsForDrain(graceMs = 500): Promise<number> {
  const sockets = [...terminalSockets];
  for (const socket of sockets) {
    try {
      socket.send(JSON.stringify({ type: "server_draining", retry_after_seconds: 5 }));
      socket.close(1012, "server draining");
    } catch {
      // already closed
    }
  }
  if (sockets.length > 0) await Bun.sleep(graceMs);
  return sockets.length;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isObservationRequest(req: Request, url: URL): boolean {
  if (req.method === "GET") return true;
  return url.pathname === "/agent/runs/abort"
    || url.pathname.endsWith("/stop");
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
      activeSseConnections += 1;
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
      activeSseConnections = Math.max(0, activeSseConnections - 1);
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

function sidePromptStream(
  sessionId: string,
  prompt: string,
  options: { systemPrompt?: string; signal: AbortSignal; operationId: string },
): Response {
  const operation = beginOperation("side_prompt");
  const encoder = new TextEncoder();
  const abort = createSidePromptAbortController(options.signal);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (event: string, data: unknown) => {
    controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      send("side_prompt_start", { chat_jid: sessionId, operation_id: options.operationId });
      void runSidePrompt(sessionId, prompt, {
        systemPrompt: options.systemPrompt,
        signal: abort.signal,
        operationId: options.operationId,
        onTextDelta: (delta) => send("side_prompt_text_delta", { delta }),
        onThinkingDelta: (delta) => send("side_prompt_thinking_delta", { delta }),
      }).then((result) => {
        send(result.status === "success" ? "side_prompt_done" : "side_prompt_error", result);
      }).catch((error) => {
        send("side_prompt_error", {
          status: "error",
          result: null,
          thinking: null,
          error: error instanceof Error ? error.message : String(error),
          model: null,
        });
      }).finally(() => {
        operation.finish();
        controller?.close();
      });
    },
    cancel() {
      controller = null;
      abort.cancel();
      operation.finish();
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
      activeSseConnections += 1;
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
      activeSseConnections = Math.max(0, activeSseConnections - 1);
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
    return applyCors(req, await handler({ userId }));
  } catch (error) {
    if (error instanceof AuthError) {
      return applyCors(req, json({ error: error.message }, 401));
    }
    throw error;
  }
}

async function withChatAuth(
  req: Request,
  chatJid: string | null,
  handler: (ctx: RequestContext & { chatJid: string }) => Promise<Response>,
  options: { allowMissing?: boolean } = {},
): Promise<Response> {
  if (!chatJid) {
    if (options.allowMissing) {
      return applyCors(req, json({ error: "chat_jid required" }, 400));
    }
    return applyCors(req, json({ error: "chat_jid required" }, 400));
  }
  return withAuth(req, async ({ userId }) => {
    await requireSessionAccess(chatJid, userId);
    return handler({ userId, chatJid });
  });
}

export async function bootstrapSchema(): Promise<void> {
  if (process.env.CLOUD_SKIP_MIGRATIONS === "1") return;
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
      const mutation = !isObservationRequest(req, url);
      const admission = mutation && url.pathname !== "/terminal/ws"
        ? beginOperationIfAccepting("admission")
        : null;
      if (admission && !admission.accepted) return respond(drainingResponse());

      try {
        if (req.method === "GET" && url.pathname === "/health") {
          const ready = !isDraining();
          return respond(json({
            ok: true,
            ready,
            draining: !ready,
            activeRequests: getActiveRequestCount(),
            activeOperations: getActiveOperationCounts(),
            replica: config.replicaId,
            sandbox: config.sandboxEnabled,
          }));
        }

        if (req.method === "GET" && url.pathname === "/live") {
          return respond(json({ ok: true, replica: config.replicaId }));
        }

        if (req.method === "GET" && url.pathname === "/ready") {
          const ready = !isDraining();
          return respond(json({
            ok: ready,
            ready,
            draining: !ready,
            activeOperations: getActiveOperationCounts(),
            replica: config.replicaId,
          }, ready ? 200 : 503));
        }

        // ── Web UI compatibility ──────────────────────────────────────

        if (req.method === "GET" && url.pathname === "/sse/stream") {
          return withAuth(req, async ({ userId }) => {
            const chatJid = readRequestChatJid(url);
            if (!chatJid) return respond(noopSseResponse());
            await requireSessionAccess(chatJid, userId);
            const sessionId = await ensureChatSession(chatJid);
            return respond(sseResponse(sessionId, chatJid));
          });
        }

        if (req.method === "GET" && url.pathname === "/timeline") {
          return withAuth(req, async ({ userId }) => {
            const chatJid = readRequestChatJid(url);
            const limit = Number(url.searchParams.get("limit") || 10);
            if (!chatJid) return respond(json({ posts: [], limit, has_more: false }));
            await requireSessionAccess(chatJid, userId);
            const beforeRaw = url.searchParams.get("before_id");
            const before = beforeRaw ? Number(beforeRaw) : null;
            return respond(json(await getTimeline(chatJid, limit, before)));
          });
        }

        if (req.method === "GET" && url.pathname === "/agent/status") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return withAuth(req, async () => respond(json(idleAgentStatusPayload())));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await getAgentStatus(jid))),
          );
        }

        if (req.method === "GET" && url.pathname === "/agent/queue-state") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return withAuth(req, async () => respond(json(emptyQueueState())));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await getQueueState(jid))),
          );
        }

        if (req.method === "GET" && url.pathname === "/agent/roster") {
          return withAuth(req, async ({ userId }) => respond(json({
            ...getAgentsRoster(),
            account_scope: userId,
          })));
        }

        if (req.method === "GET" && url.pathname === "/agent/active-chats") {
          return withAuth(req, async ({ userId }) => respond(json(await getActiveChatAgents(userId))));
        }

        if (req.method === "GET" && url.pathname === "/agent/branches") {
          return withAuth(req, async ({ userId }) => {
            return respond(json(await getChatBranches({ userId })));
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-delete") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            if (!chatJid) return respond(json({ error: "Missing chat_jid" }, 400));
            try {
              return respond(json(await deleteChatBranch(chatJid, userId)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error || "Failed to delete branch.");
              return respond(json({ error: message || "Failed to delete branch." }, 400));
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
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const sourceChatJid = typeof body.source_chat_jid === "string"
              ? body.source_chat_jid.trim()
              : "";
            if (!sourceChatJid) return respond(json({ error: "source_chat_jid required" }, 400));
            try {
              const branch = await createForkedChatBranch(
                sourceChatJid,
                userId,
                body.agent_name,
                body.message_id ?? body.forked_from_message_id,
              );
              return respond(json({ status: "ok", branch }, 201));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ error: message }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/branch-merge-parent") {
          return withAuth(req, async ({ userId }) => {
            const body = await readJson(req);
            const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
            if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
            try {
              return respond(json(await mergeChatBranchIntoParent(chatJid, userId)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ error: message }, 400));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/root-session") {
          return withAuth(req, async ({ userId }) => respond(json(await createRootChatSession(userId))));
        }

        if (req.method === "POST" && url.pathname === "/agent/ui-state") {
          return withAuth(req, async () => respond(json({ ok: true })));
        }

        if (req.method === "POST" && url.pathname === "/agent/question/answer") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const questionId = String(body.question_id ?? body.questionId ?? "");
          const answer = String(body.answer ?? body.content ?? "");
          if (!questionId || !answer) return respond(json({ error: "question_id and answer required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await answerAgentQuestion(jid, questionId, answer))),
          );
        }

        if (req.method === "POST" && url.pathname === "/agent/mode") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const mode = body.mode === "plan" ? "plan" : "execute";
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await setAgentMode(jid, mode))),
          );
        }

        if (req.method === "GET" && url.pathname === "/agent/subagents") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return withAuth(req, async () => respond(json({ runs: [] })));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await listSessionSubagents(jid))),
          );
        }

        if (url.pathname === "/media/upload" || url.pathname.startsWith("/media/")) {
          return withAuth(req, async ({ userId }) => {
            const mediaResponse = await handleMediaRoutes(req, url.pathname, userId);
            if (mediaResponse) return respond(mediaResponse);
            return respond(json({ error: "not found" }, 404));
          });
        }

        if (req.method === "GET" && url.pathname === "/agent/scheduled-tasks") {
          return withAuth(req, async ({ userId }) =>
            respond(await handleScheduledTasksList(req, url, userId)),
          );
        }

        if (req.method === "POST" && url.pathname === "/agent/scheduled-tasks/action") {
          return withAuth(req, async ({ userId }) =>
            respond(await handleScheduledTasksAction(req, userId)),
          );
        }

        if (req.method === "POST" && url.pathname === "/internal/scheduled-tasks/execute") {
          return respond(await handleInternalScheduledTaskExecute(req, config.schedulerServiceKey));
        }

        if (req.method === "POST" && url.pathname === "/internal/scheduled-tasks/subagent") {
          const serviceKey = req.headers.get("X-Piclaw-Service-Key")?.trim() || "";
          if (
            isPlaceholderSchedulerServiceKey(config.schedulerServiceKey)
            || isPlaceholderSchedulerServiceKey(serviceKey)
            || serviceKey !== config.schedulerServiceKey
          ) {
            return respond(json({ error: "internal service authentication required" }, 401));
          }
          const body = await readJson(req);
          const taskId = typeof body.id === "string" ? body.id.trim() : "";
          const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
          const claimToken = typeof body.claim_token === "string" ? body.claim_token.trim() : "";
          const task = await store.getScheduledTaskById(taskId);
          if (
            !task
            || task.task_kind === "internal"
            || task.session_id !== sessionId
            || task.claim_token !== claimToken
            || !task.claim_expires_at
            || new Date(task.claim_expires_at).getTime() <= Date.now()
          ) {
            return respond(json({ error: "invalid or expired scheduled task claim" }, 409));
          }
          const invocation = task.invocation ?? {
            version: 1,
            agentType: "general-purpose",
            executionBackend: "sandbox",
            prompt: task.prompt,
            description: `scheduled:${task.id}`,
          };
          const agentType = typeof invocation.agentType === "string"
            ? invocation.agentType
            : "general-purpose";
          const profile = await import("./subagents/profiles.ts")
            .then(({ resolveSubagentProfile }) => resolveSubagentProfile(agentType as never, sessionId));
          if (
            typeof invocation.executionBackend === "string"
            && invocation.executionBackend !== profile.executionBackend
          ) {
            return respond(json({
              success: false,
              error: `scheduled invocation backend mismatch: stored=${invocation.executionBackend}, profile=${profile.executionBackend}`,
            }, 409));
          }
          if (!(await store.beginScheduledTaskExecution(taskId, claimToken))) {
            return respond(json({ error: "scheduled task claim already executing" }, 409));
          }
          const result = await spawnSubagentViaApi(sessionId, {
            prompt: typeof invocation.prompt === "string" ? invocation.prompt : task.prompt,
            description: typeof invocation.description === "string"
              ? invocation.description
              : `scheduled:${task.id}`,
            subagent_type: agentType,
            model: typeof invocation.model === "string" ? invocation.model : undefined,
            max_turns: typeof invocation.maxTurns === "number" ? invocation.maxTurns : undefined,
            timeout_ms: typeof invocation.timeoutMs === "number" ? invocation.timeoutMs : undefined,
            profile_overrides: invocation.profileOverrides && typeof invocation.profileOverrides === "object"
              ? invocation.profileOverrides
              : undefined,
            run_in_background: false,
            require_immediate_start: true,
          }, req.signal);
          if (!result.success) return respond(json({ success: false, error: result.error }, 400));
          const outcome = result.data as { status?: string; summary?: string; error?: string } | undefined;
          if (outcome?.status === "queued") {
            const reset = await store.resetScheduledTaskExecutionForRetry(taskId, claimToken);
            if (!reset) {
              return respond(json({
                success: false,
                retryable: false,
                error: "scheduled task claim lost while rejecting capacity",
              }, 409));
            }
            return respond(json({
              success: false,
              retryable: true,
              error: outcome.error ?? "subagent capacity unavailable",
            }, 503));
          }
          if (outcome?.status !== "completed") {
            return respond(json({
              success: false,
              retryable: false,
              error: outcome?.error ?? `scheduled agent ended with status ${outcome?.status ?? "unknown"}`,
            }, 500));
          }
          const delivery = await store.deliverScheduledTaskOutcome(
            taskId,
            claimToken,
            outcome.summary ?? "",
          );
          if (!delivery.delivered || delivery.messageId == null) {
            return respond(json({
              success: false,
              retryable: false,
              error: "scheduled task claim lost before outcome delivery",
            }, 409));
          }
          await publish(sessionId, {
            type: "message",
            id: delivery.messageId,
            role: "assistant",
            content: outcome.summary ?? "",
          });
          return respond(json({
            success: true,
            summary: outcome.summary ?? "",
            data: result.data,
          }));
        }

        if (req.method === "GET" && url.pathname === "/agent/settings-data") {
          return withAuth(req, async ({ userId }) => respond(json(await getSettingsData(userId))));
        }

        if (req.method === "GET" && url.pathname.startsWith("/agent/settings/")) {
          if (url.pathname === "/agent/settings/general") {
            return withAuth(req, async ({ userId }) => respond(await handleGeneralSettingsRoute(req, userId)));
          }
          if (url.pathname === "/agent/settings/compaction") {
            return withAuth(req, async ({ userId }) => respond(await handleCompactionSettingsRoute(req, userId)));
          }
          if (url.pathname === "/agent/settings/environment") {
            return withAuth(req, async () =>
              respond(json({ ok: true, settings: { variables: [], overrides: {}, count: 0, overrideCount: 0, keychainEnvNames: [] } })),
            );
          }
          return withAuth(req, async () => respond(json({})));
        }

        if (req.method === "POST" && url.pathname === "/agent/settings/general") {
          return withAuth(req, async ({ userId }) => respond(await handleGeneralSettingsRoute(req, userId)));
        }

        if (req.method === "POST" && url.pathname === "/agent/settings/compaction") {
          return withAuth(req, async ({ userId }) => respond(await handleCompactionSettingsRoute(req, userId)));
        }

        if (req.method === "POST" && url.pathname === "/agent/settings/workspace") {
          return withAuth(req, async () => respond(await handleWorkspaceSettingsRoute(req)));
        }

        if (req.method === "POST" && url.pathname === "/agent/settings/compaction/reset-backoff") {
          return withAuth(req, async ({ userId }) =>
            respond(json({ ok: true, settings: await store.getCompactionSettingsSnapshot(userId) })),
          );
        }

        if (url.pathname.startsWith("/agent/keychain")) {
          return withAuth(req, async ({ userId }) => {
            const keychainResponse = await handleKeychainRoutes(req, url.pathname, userId);
            return respond(keychainResponse ?? json({ error: "not found" }, 404));
          });
        }

        if (url.pathname.startsWith("/agent/recordings") || url.pathname === "/recordings/playback") {
          return withAuth(req, async ({ userId }) => {
            const recordingResponse = await handleSessionRecordingRoutes(req, url.pathname, userId);
            return respond(recordingResponse ?? json({ error: "not found" }, 404));
          });
        }

        if (url.pathname.startsWith("/agent/addons/")) {
          return withAuth(req, async () => {
            const addonResponse = await handleAddonRoutes(req, url.pathname, url);
            return respond(addonResponse ?? json({ error: "not found" }, 404));
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-steer") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const rowId = Number(body.row_id);
          if (!Number.isFinite(rowId)) return respond(json({ error: "row_id required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await steerQueueItem(jid, rowId))),
          );
        }

        if (req.method === "POST" && url.pathname === "/agent/queue-remove") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const body = await readJson(req);
          const rowId = Number(body.row_id);
          if (!Number.isFinite(rowId)) return respond(json({ error: "row_id required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await removeQueueItem(jid, rowId))),
          );
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
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await reorderQueueItems(jid, fromIndex, toIndex))),
          );
        }

        if (req.method === "GET" && url.pathname === "/agent/commands") {
          return withAuth(req, async () => respond(json({ commands: await buildAgentCommandList() })));
        }

        if (req.method === "GET" && url.pathname === "/agent/session-tree") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ leafId: null, nodes: [], error: "chat_jid required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) => {
            try {
              return respond(json(await getSessionTreeForChat(jid)));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ leafId: null, nodes: [], error: message }, 200));
            }
          });
        }

        if (req.method === "GET" && url.pathname === "/agent/system-metrics") {
          return withAuth(req, async () => {
            const host = readSystemMetrics({
              active_chats: 0,
              replica_id: config.replicaId,
            });
            const usage = await store.getPlatformUsageMetrics();
            return respond(json({
              ...host,
              cloud_usage: usage,
              active_requests: getActiveRequestCount(),
              active_operations: getActiveOperationCounts(),
              active_sse_connections: activeSseConnections,
              active_terminal_sockets: terminalSockets.size,
              draining: isDraining(),
            }));
          });
        }

        if (req.method === "GET" && url.pathname === "/agent/models") {
          return withAuth(req, async ({ userId }) => respond(await handleModelsRoute(req, url, userId)));
        }

        if (req.method === "GET" && url.pathname === "/agent/context") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) {
            return withAuth(req, async () =>
              respond(json({
                tokens: null,
                context_window: null,
                contextWindow: null,
                percent: null,
                context: { used: null, total: null, remaining: null, percent: null },
                dailyQuota: null,
                sessionUsage: null,
                cacheUsage: null,
              })),
            );
          }
          return withChatAuth(req, chatJid, async ({ chatJid: jid, userId }) => {
            const sessionId = chatJidToSessionId(jid);
            const [sessionUsage, daily, persisted, cursor, latestCompaction, sessionRuntime] = await Promise.all([
              store.getSessionTokenUsageForUser(sessionId, userId),
              store.getDailyTokenUsageBreakdown(userId),
              store.getSessionContextSnapshotForUser(sessionId, userId),
              store.getCursor(sessionId),
              store.getLatestCompaction(sessionId),
              resolveSessionKernelModel(sessionId),
            ]);
            if (!sessionUsage) {
              throw new AuthError("session access denied");
            }
            const activeUserBoundary = Number(
              cursor?.inflight_message_id
                ?? cursor?.cursor_message_id
                ?? persisted?.throughMessageId
                ?? 0,
            );
            const boundedRows = activeUserBoundary > 0
              ? await store.hydrateCommittedContext(sessionId, { count: 0 }, {
                  activeUserMessageId: activeUserBoundary,
                  afterMessageId: latestCompaction?.compactedThroughMessageId,
                })
              : [];
            const latestMessageId = Math.max(
              activeUserBoundary,
              latestCompaction?.compactedThroughMessageId ?? 0,
              ...boundedRows.map((row) => row.id),
            );
            let context = resolveContextSnapshot({
              persisted,
              local: getContextUsage(sessionId),
            });
            const compactedThroughMessageId = latestCompaction?.compactedThroughMessageId ?? 0;
            if (
              !persisted
              || !isContextSnapshotFresh(persisted, latestMessageId, compactedThroughMessageId)
            ) {
              const messages = rowsToAgentMessages(
                hydrateWithCompaction(boundedRows, latestCompaction),
                sessionRuntime.model.id,
              );
              context = buildEstimatedContextSnapshot({
                messages,
                contextWindow: sessionRuntime.model.contextWindow,
                model: sessionRuntime.model.id,
                provider: sessionRuntime.providerId,
                throughMessageId: activeUserBoundary,
                latestMessageId,
                compactedThroughMessageId,
              });
              const written = await store.upsertSessionContextSnapshot({
                sessionId,
                userId,
                usedTokens: context.tokens,
                contextWindow: context.contextWindow,
                model: context.model,
                provider: context.provider,
                throughMessageId: context.throughMessageId,
                latestMessageId: context.latestMessageId,
                compactedThroughMessageId: context.compactedThroughMessageId,
              });
              if (written) {
                context = { ...context, updatedAt: written.updatedAt };
              }
            }
            return respond(json(buildContextUsagePayload({
              context,
              fallbackContextWindow: sessionRuntime.model.contextWindow,
              daily,
              dailyLimit: config.maxDailyTokensPerUser,
              sessionUsage,
            })));
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/side-prompt/stream") {
          const body = await readJson(req);
          const chatJid = readRequestChatJid(url)
            ?? (typeof body.chat_jid === "string" ? body.chat_jid.trim() : null);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) return respond(json({ error: "prompt required" }, 400));
          const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : undefined;
          const operationId = typeof body.operation_id === "string" && body.operation_id.trim()
            ? body.operation_id.trim()
            : crypto.randomUUID();
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) => {
            const sessionId = chatJidToSessionId(jid);
            try {
              await assertSidePromptQuota(sessionId);
            } catch (error) {
              if (error instanceof QuotaExceededError) {
                return respond(json(error.toJson(), 429));
              }
              throw error;
            }
            return respond(sidePromptStream(sessionId, prompt, {
              systemPrompt,
              signal: req.signal,
              operationId,
            }));
          });
        }

        if (req.method === "GET" && url.pathname === "/agent/autoresearch/status") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(await getAutoresearchStatus(chatJidToSessionId(jid)))),
          );
        }

        if (req.method === "POST" && url.pathname === "/agent/autoresearch/start") {
          const body = await readJson(req);
          const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          if (!prompt) return respond(json({ error: "prompt required" }, 400));
          return withChatAuth(req, chatJid, async ({ userId, chatJid: jid }) => {
            try {
              const run = await startAutoresearch({ sessionId: chatJidToSessionId(jid), userId, prompt });
              return respond(json({ ok: true, run }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return respond(json({ ok: false, error: message }, 409));
            }
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/autoresearch/stop") {
          const body = await readJson(req);
          const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) => {
            const result = await stopAutoresearch(chatJidToSessionId(jid));
            return respond(json(result, result.ok ? 200 : 409));
          });
        }

        if (req.method === "POST" && url.pathname === "/agent/autoresearch/dismiss") {
          const body = await readJson(req);
          const chatJid = typeof body.chat_jid === "string" ? body.chat_jid.trim() : "";
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) => {
            const result = await dismissAutoresearch(chatJidToSessionId(jid));
            return respond(json(result, result.ok ? 200 : 409));
          });
        }


        if (url.pathname.startsWith("/agent/push/")) {
          return withAuth(req, async ({ userId }) => {
            const pushResponse = await handleWebPushRoutes(req, url.pathname, userId);
            return respond(pushResponse ?? json({ error: "not found" }, 404));
          });
        }

        if (req.method === "GET" && url.pathname === "/terminal/session") {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) {
            return withAuth(req, async () =>
              respond(json({
                enabled: config.sandboxEnabled,
                transport: "websocket",
                ws_path: "/terminal/ws",
                cwd: "/workspace",
                shell: "/bin/bash",
                active: false,
                connected_clients: 0,
              })),
            );
          }
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) =>
            respond(json(getTerminalSessionInfo(jid))),
          );
        }

        if (req.method === "POST" && url.pathname === "/terminal/handoff") {
          return withAuth(req, async () => respond(json(createTerminalHandoff())));
        }

        if (req.method === "POST" && url.pathname === "/agent/runs/abort") {
          return withChatAuth(req, readRequestChatJid(url), async ({ chatJid: jid }) =>
            respond(json(await abortAgentRunForChat(jid))),
          );
        }

        if (req.method === "POST" && parts[0] === "agent" && parts[1] && parts[2] === "message") {
          return withAuth(req, async ({ userId }) => {
            const chatJid = readRequestChatJid(url);
            const body = await readJson(req);
            const content = String(body.content || "");
            if (!content) return respond(json({ error: "content required" }, 400));
            const mode = typeof body.mode === "string" ? body.mode : null;
            try {
              const operation = beginOperation("turn");
              const result = await sendAgentMessageWithOptionalCreate(chatJid, content, mode, userId)
                .finally(() => operation.finish());
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
          const terminalAdmission = beginOperationIfAccepting("terminal_admission");
          if (!terminalAdmission.accepted) return respond(drainingResponse());
          const chatJid = readRequestChatJid(url);
          if (!chatJid) {
            terminalAdmission.operation.finish();
            return respond(json({ error: "chat_jid required" }, 400));
          }
          return withChatAuth(req, chatJid, async ({ chatJid: jid }) => {
            const sessionId = chatJidToSessionId(jid);
            const upgraded = server.upgrade(req, {
              data: { sessionId, chatJid: jid, admission: terminalAdmission.operation },
            });
            if (upgraded) return undefined as unknown as Response;
            terminalAdmission.operation.finish();
            return respond(json({ error: "websocket upgrade failed" }, 400));
          });
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
              const session = await store.getSessionForUser(sessionId, userId);
              if (!session) return respond(json({ error: "unknown session" }, 404));
              return respond(json({ session }));
            });
          }

          if (req.method === "GET" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              return respond(json({ messages: await store.listMessagesForUser(sessionId, userId) }));
            });
          }

          if (req.method === "POST" && parts[2] === "messages") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const body = await readJson(req);
              const content = String(body.content || "");
              if (!content) return respond(json({ error: "content required" }, 400));
              if (!(await store.getSessionForUser(sessionId, userId))) {
                return respond(json({ error: "unknown session" }, 404));
              }

              const operation = beginOperation("turn");
              const outcomePromise = submitMessage(sessionId, content).finally(() => operation.finish());
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
              return respond(json({ runs: await store.listSubagentRunsForUser(sessionId, userId) }));
            });
          }

          if (req.method === "POST" && parts[2] === "subagents") {
            return withAuth(req, async ({ userId }) => {
              await requireSessionAccess(sessionId, userId);
              const body = await readJson(req);
              const result = await spawnSubagentViaApi(sessionId, body, req.signal);
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

        if (url.pathname.startsWith("/workspace/")) {
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));
          return withChatAuth(req, chatJid, async ({ userId }) => {
            const workspaceResponse = await handleWorkspaceRoutes(req, url.pathname, userId);
            if (workspaceResponse) return respond(workspaceResponse);
            return respond(json({ error: "not found" }, 404));
          });
        }

        if (parts[0] === "subagents" && parts[1]) {
          const runId = parts[1];
          const chatJid = readRequestChatJid(url);
          if (!chatJid) return respond(json({ error: "chat_jid required" }, 400));

          if (req.method === "GET" && parts.length === 2) {
            return withChatAuth(req, chatJid, async ({ userId }) => {
              if (!(await store.getSubagentRunForUser(runId, userId))) {
                return respond(json({ error: "subagent access denied" }, 401));
              }
              return respond(json(await getSubagentStatus(chatJid, runId)));
            });
          }

          if (req.method === "GET" && parts[2] === "messages") {
            return withChatAuth(req, chatJid, async ({ userId }) => {
              if (!(await store.getSubagentRunForUser(runId, userId))) {
                return respond(json({ error: "subagent access denied" }, 401));
              }
              return respond(json(await getSubagentTranscript(chatJid, runId)));
            });
          }

          if (req.method === "POST" && parts[2] === "steer") {
            const body = await readJson(req);
            const message = String(body.message ?? body.content ?? "");
            if (!message) return respond(json({ success: false, error: "message required" }, 400));
            return withChatAuth(req, chatJid, async ({ userId }) => {
              if (!(await store.getSubagentRunForUser(runId, userId))) {
                return respond(json({ error: "subagent access denied" }, 401));
              }
              return respond(json(await steerSubagentForChat(chatJid, runId, message)));
            });
          }

          if (req.method === "POST" && parts[2] === "stop") {
            return withChatAuth(req, chatJid, async ({ userId }) => {
              if (!(await store.getSubagentRunForUser(runId, userId))) {
                return respond(json({ error: "subagent access denied" }, 401));
              }
              return respond(json(await stopSubagentForChat(chatJid, runId)));
            });
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
      } finally {
        if (admission?.accepted) admission.operation.finish();
      }
    },
    websocket: {
      async open(ws) {
        const data = ws.data as {
          sessionId: string;
          chatJid: string;
          sandbox?: Awaited<ReturnType<typeof import("./sandbox/session.ts").ensureSandbox>>;
          terminal?: { pid: number; kill?: () => Promise<boolean> };
          operation?: ReturnType<typeof beginOperation>;
          admission?: ReturnType<typeof beginOperation>;
        };
        data.operation = beginOperation("terminal");
        data.admission?.finish();
        terminalSockets.add(ws);
        try {
          const { ensureSandbox } = await import("./sandbox/session.ts");
          const sandbox = await ensureSandbox(data.sessionId);
          data.sandbox = sandbox;
          const session = await store.getSession(data.sessionId);
          const onData = (chunk: string | Uint8Array) => {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            try {
              ws.send(text);
            } catch {
              // client gone
            }
          };
          const terminal = await attachTerminal({
            terminalPid: session?.terminal_pid,
            connect: (pid) => sandbox.pty.connect(pid, { onData }),
            create: () => sandbox.pty.create({
              cols: 80,
              rows: 24,
              timeoutMs: 120_000,
              onData,
            }),
            setTerminalPid: (pid) => store.setTerminalPid(data.sessionId, pid),
            clearTerminalPid: () => store.clearTerminalPid(data.sessionId),
          });
          data.terminal = terminal;
          ws.send(JSON.stringify({
            type: "session",
            session_id: data.sessionId,
            process_pid: terminal.pid,
          }));
          ws.send("\r\n[connected]\r\n");
        } catch (error) {
          data.operation.finish();
          const message = error instanceof Error ? error.message : String(error);
          ws.send(`\r\n[terminal error] ${message}\r\n`);
          ws.close();
        }
      },
      message(ws, message) {
        const data = ws.data as { sandbox?: { pty: { sendInput: (pid: number, bytes: Uint8Array) => Promise<void> } }; terminal?: { pid: number } };
        if (!data.sandbox || !data.terminal) return;
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        void forwardTerminalClientMessage(
          text,
          async (input) => data.sandbox!.pty.sendInput(data.terminal!.pid, new TextEncoder().encode(input)),
        );
      },
      close(ws) {
        const data = ws.data as { operation?: ReturnType<typeof beginOperation> };
        data.operation?.finish();
        terminalSockets.delete(ws);
        // Keep the PTY alive so a later WebSocket can reconnect to the same pid.
      },
    },
  });
}

export function startRecoverySweep(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;
  const run = () => {
    if (stopped || current) return;
    current = sweepInflight().catch((error) => {
      console.error(`[${config.replicaId}] sweep error:`, error);
    }).finally(() => {
      current = null;
      if (!stopped) timer = setTimeout(run, config.sweepIntervalMs);
    });
  };
  timer = setTimeout(run, config.sweepIntervalMs);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
  };
}
