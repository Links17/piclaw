import * as store from "@piclaw-cloud/store";
import { computeNextRun } from "@piclaw-cloud/store";
import { runCloudDreamMaintenance } from "../dream/run-maintenance.ts";
import { parseDreamPromptToken } from "../dream/constants.ts";

export async function executeInternalScheduledTask(task: {
  id: string;
  session_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
}): Promise<{ ok: boolean; summary: string; error?: string }> {
  const dreamToken = parseDreamPromptToken(task.prompt);
  if (dreamToken.matched) {
    try {
      const result = await runCloudDreamMaintenance({
        sessionId: task.session_id,
        prompt: task.prompt,
        mode: dreamToken.mode,
      });
      return { ok: !result.skipped, summary: result.summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: "", error: message };
    }
  }
  return { ok: false, summary: "", error: `Unknown internal task: ${task.prompt || "(empty)"}` };
}

export async function finalizeScheduledTaskRun(task: {
  id: string;
  schedule_type: string;
  schedule_value: string;
}, startedAt: number, outcome: { ok: boolean; summary: string; error?: string }): Promise<void> {
  const durationMs = Date.now() - startedAt;
  if (outcome.ok) {
    await store.appendTaskRunLog({
      taskId: task.id,
      durationMs,
      status: "success",
      result: outcome.summary,
    });
  } else {
    await store.appendTaskRunLog({
      taskId: task.id,
      durationMs,
      status: "error",
      error: outcome.error || outcome.summary || "Task failed",
    });
  }
  const nextRun = task.schedule_type === "once"
    ? null
    : computeNextRun(task.schedule_type, task.schedule_value, { currentDate: new Date() });
  await store.markScheduledTaskRan(task.id, nextRun, outcome.ok ? outcome.summary : null);
}
