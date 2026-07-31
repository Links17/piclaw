import { executeInternalScheduledTask, finalizeScheduledTaskRun } from "./execute-internal.ts";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleInternalScheduledTaskExecute(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const scheduleType = typeof body.schedule_type === "string" ? body.schedule_type : "cron";
  const scheduleValue = typeof body.schedule_value === "string" ? body.schedule_value : "";
  if (!id || !sessionId) return json({ ok: false, error: "id and session_id required" }, 400);

  const startedAt = Date.now();
  const outcome = await executeInternalScheduledTask({
    id,
    session_id: sessionId,
    prompt,
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
  });
  await finalizeScheduledTaskRun(
    { id, schedule_type: scheduleType, schedule_value: scheduleValue },
    startedAt,
    outcome,
  );
  return json({ ok: outcome.ok, summary: outcome.summary, error: outcome.error ?? null });
}
