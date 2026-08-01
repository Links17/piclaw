import * as store from "@piclaw-cloud/store";
import { computeNextRun } from "@piclaw-cloud/store";

const VALID_STATUSES = new Set(["active", "paused", "completed"]);

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function stringParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim() || "";
  return value || null;
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolParam(url: URL, name: string): boolean {
  const value = (url.searchParams.get(name) || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function enrichTask(
  task: store.ScheduledTaskRow,
  userId: string,
  includeRunLogs: boolean,
  runLogLimit: number,
) {
  const api = store.taskToApi(task);
  const latest = await store.listTaskRunLogsForUser(task.id, userId, 1);
  const recent_run_logs = includeRunLogs
    ? await store.listTaskRunLogsForUser(task.id, userId, runLogLimit)
    : undefined;
  return {
    ...api,
    latest_run_log: latest[0]
      ? {
          run_at: latest[0].run_at,
          duration_ms: latest[0].duration_ms,
          status: latest[0].status,
          result: latest[0].result,
          error: latest[0].error,
          result_summary: latest[0].result,
          error_summary: latest[0].error,
        }
      : null,
    ...(recent_run_logs
      ? {
          recent_run_logs: recent_run_logs.map((log) => ({
            run_at: log.run_at,
            duration_ms: log.duration_ms,
            status: log.status,
            result: log.result,
            error: log.error,
            result_summary: log.result,
            error_summary: log.error,
          })),
        }
      : {}),
  };
}

export async function handleScheduledTasksList(req: Request, url: URL, userId: string): Promise<Response> {
  const id = stringParam(url, "id");
  const chatJid = stringParam(url, "chat_jid");
  const statusRaw = stringParam(url, "status");
  const status = statusRaw && VALID_STATUSES.has(statusRaw) ? statusRaw as store.ScheduledTaskStatus : null;
  const limit = numberParam(url, "limit", 50);
  const includeRunLogs = boolParam(url, "include_run_logs") || Boolean(id);
  const runLogLimit = numberParam(url, "run_log_limit", 5);

  if (id) {
    const task = await store.getScheduledTaskByIdForUser(id, userId);
    if (!task) return json({ ok: false, found: false, error: `No scheduled task found for ${id}.`, task: null }, 404);
    return json({ ok: true, found: true, task: await enrichTask(task, userId, true, runLogLimit) });
  }

  if (!chatJid) return json({ ok: false, error: "chat_jid required" }, 400);
  const session = await store.getSessionForUser(chatJid, userId);
  if (!session) return json({ ok: false, error: "scheduled task access denied" }, 401);
  const tasks = await store.listScheduledTasksForUser({
    userId,
    sessionId: chatJid ?? undefined,
    status,
    limit,
  });
  const enriched = await Promise.all(tasks.map((task) => enrichTask(task, userId, includeRunLogs, runLogLimit)));
  return json({
    ok: true,
    tasks: enriched,
    count: enriched.length,
    filters: { chat_jid: chatJid, status, limit, include_run_logs: includeRunLogs, run_log_limit: runLogLimit },
  });
}

export async function handleScheduledTasksAction(req: Request, userId: string): Promise<Response> {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const allowInternal = body.allow_internal === true;

  if (!id) return json({ ok: false, action, error: "Missing scheduled task id." }, 400);
  const task = await store.getScheduledTaskByIdForUser(id, userId);
  if (!task) return json({ ok: false, action, error: `No scheduled task found for ${id}.`, id }, 404);
  if (task.task_kind === "internal" && !allowInternal) {
    return json({
      ok: false,
      action,
      error: `Task ${id} is internal and requires allow_internal=true.`,
      id,
      protected: true,
      task_kind: task.task_kind,
      status: task.status,
    }, 403);
  }

  if (action === "pause") {
    if (task.status === "completed") {
      return json({ ok: false, action, error: `Task ${id} is completed and cannot be paused.`, id, status: task.status }, 409);
    }
    if (task.status !== "paused") await store.updateScheduledTaskForUser(id, userId, { status: "paused" });
  } else if (action === "resume") {
    if (!task.next_run && task.schedule_type !== "interval") {
      const nextRun = computeNextRun(task.schedule_type, task.schedule_value);
      if (!nextRun) {
        return json({ ok: false, action, error: `Task ${id} has no next_run and cannot be resumed.`, id, status: task.status }, 409);
      }
      await store.updateScheduledTaskForUser(id, userId, { status: "active", next_run: nextRun });
    } else if (task.status !== "active") {
      await store.updateScheduledTaskForUser(id, userId, { status: "active" });
    }
  } else if (action === "delete") {
    await store.deleteScheduledTaskForUser(id, userId);
    return json({ ok: true, action, id, deleted: true, task_kind: task.task_kind, old_status: task.status });
  } else {
    return json({ ok: false, action: action || "unknown", error: "Unsupported scheduled task action." }, 400);
  }

  const updated = await store.getScheduledTaskByIdForUser(id, userId);
  return json({
    ok: true,
    action,
    id,
    task: updated ? await enrichTask(updated, userId, true, 5) : null,
    old_status: task.status,
    new_status: updated?.status ?? null,
  });
}
