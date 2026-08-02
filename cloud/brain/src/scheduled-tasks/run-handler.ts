import * as store from "@piclaw-cloud/store";
import { isPlaceholderSchedulerServiceKey } from "@piclaw-cloud/shared/cloud-config";
import { executeInternalScheduledTask } from "./execute-internal.ts";
import { beginOperation } from "../operations.ts";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleInternalScheduledTaskExecute(
  req: Request,
  expectedServiceKey: string,
): Promise<Response> {
  const serviceKey = req.headers.get("X-Piclaw-Service-Key")?.trim() || "";
  if (
    isPlaceholderSchedulerServiceKey(expectedServiceKey)
    || isPlaceholderSchedulerServiceKey(serviceKey)
    || serviceKey !== expectedServiceKey
  ) {
    return json({ ok: false, error: "internal service authentication required" }, 401);
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const claimToken = typeof body.claim_token === "string" ? body.claim_token.trim() : "";
  if (!id || !sessionId || !claimToken) return json({ ok: false, error: "id, session_id, and claim_token required" }, 400);
  const claimed = await store.getClaimedInternalScheduledTask(id, claimToken);
  if (!claimed || claimed.session_id !== sessionId) {
    return json({ ok: false, error: "invalid or expired internal task claim" }, 401);
  }
  if (!(await store.beginScheduledTaskExecution(id, claimToken))) {
    return json({ ok: false, error: "scheduled task claim already executing" }, 409);
  }

  const operation = beginOperation("scheduled_internal");
  try {
    const outcome = await executeInternalScheduledTask({
      id: claimed.id,
      session_id: claimed.session_id,
      prompt: claimed.prompt,
      schedule_type: claimed.schedule_type,
      schedule_value: claimed.schedule_value,
      timezone: claimed.timezone,
    }, req.signal);
    return json({ ok: outcome.ok, summary: outcome.summary, error: outcome.error ?? null });
  } finally {
    operation.finish();
  }
}
