import * as store from "@piclaw-cloud/store";
import { computeNextRun } from "@piclaw-cloud/store";
import { config } from "../config.ts";
import {
  DREAM_CRON,
  DREAM_TASK_ID,
  DREAM_TASK_KIND,
  DREAM_TASK_PROMPT,
} from "./constants.ts";

type DreamTaskStore = Pick<
  typeof store,
  "getSession" | "createSession" | "getScheduledTaskById" | "upsertScheduledTask" | "updateScheduledTask"
>;

function normalizeNextRun(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** Seed or refresh the global midnight Dream internal task. */
export async function ensureDreamTask(
  sessionId = config.defaultChatJid,
  taskStore: DreamTaskStore = store,
): Promise<void> {
  if (!(await taskStore.getSession(sessionId))) {
    await taskStore.createSession(sessionId, "PiClaw");
  }
  const existing = await taskStore.getScheduledTaskById(DREAM_TASK_ID);
  const nextRun = computeNextRun("cron", DREAM_CRON);
  if (!existing) {
    await taskStore.upsertScheduledTask({
      id: DREAM_TASK_ID,
      sessionId,
      prompt: DREAM_TASK_PROMPT,
      scheduleType: "cron",
      scheduleValue: DREAM_CRON,
      nextRun,
      taskKind: DREAM_TASK_KIND,
      status: "active",
    });
    return;
  }
  const shouldRecompute = existing.schedule_type !== "cron"
    || existing.schedule_value !== DREAM_CRON
    || !existing.next_run;
  const existingNextRun = normalizeNextRun(existing.next_run);
  await taskStore.updateScheduledTask(DREAM_TASK_ID, {
    prompt: DREAM_TASK_PROMPT,
    task_kind: DREAM_TASK_KIND,
    schedule_type: "cron",
    schedule_value: DREAM_CRON,
    next_run: shouldRecompute ? nextRun : existingNextRun,
    status: "active",
  });
}
