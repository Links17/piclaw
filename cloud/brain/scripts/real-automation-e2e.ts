/**
 * Real automation acceptance:
 * - real Brain HTTP API and LLM-backed autoresearch
 * - PostgreSQL/Redis persistence
 * - real scheduled-task claim, Brain internal execution, and run log
 * - real CubeSandbox volume writes from Dream maintenance
 *
 * This script intentionally has no mocks. It must run against the configured
 * real services and always writes a cleanup/report record.
 */
import * as store from "@piclaw-cloud/store";
import { sql } from "@piclaw-cloud/store/db";
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { connectSandbox } from "../src/sandbox/client.ts";
import { readFile } from "../src/sandbox/fs.ts";
import { WORKSPACE_ROOT } from "../src/tools/path.ts";
import { DREAM_TASK_ID } from "../src/dream/constants.ts";

export function isValidIsoTimestamp(value: string | null | undefined): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() !== "Invalid Date";
}

const BASE = process.env.CLOUD_E2E_BASE || "http://127.0.0.1:17804";
const schedulerServiceKey = getCloudConfig().scheduler.serviceKey;
const run = new RealAcceptance();
const sessionId = run.session("automation");
const taskId = `${run.id}-dream`;

function statusPanelState(body: Record<string, unknown>): string | undefined {
  const content = body.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  if (!first || typeof first !== "object") return undefined;
  const panel = (first as { panel?: unknown }).panel;
  if (!panel || typeof panel !== "object") return undefined;
  const state = (panel as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

async function jsonFetch(path: string, init?: RequestInit): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

async function postJson(path: string, body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  return jsonFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(path.startsWith("/internal/scheduled-tasks/")
        ? { "X-Piclaw-Service-Key": schedulerServiceKey }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  name: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await Bun.sleep(500);
    value = await read();
  }
  if (!predicate(value)) throw new Error(`timeout waiting for ${name}`);
  return value;
}

async function readSandboxPath(path: string): Promise<string> {
  const session = await store.getSession(sessionId);
  if (!session?.sandbox_id) throw new Error("Dream did not bind a sandbox to the session");
  const sandbox = await connectSandbox(session.sandbox_id);
  return readFile(sandbox, path);
}

async function readRequiredSandboxPath(path: string, label: string): Promise<string> {
  try {
    return await readSandboxPath(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    run.check(false, label, detail);
    throw error;
  }
}

async function readDreamDailyNote(): Promise<string> {
  const session = await store.getSession(sessionId);
  if (!session?.sandbox_id) throw new Error("Dream did not bind a sandbox to the session");
  const sandbox = await connectSandbox(session.sandbox_id);
  const lookup = await sandbox.commands.run(
    `find ${WORKSPACE_ROOT}/notes/daily -type f -name '*.md' -print -quit`,
    { timeoutMs: 15_000 },
  );
  const path = lookup.stdout.trim();
  if (lookup.exitCode !== 0 || !path) {
    throw new Error(`Dream daily note not found (exit ${lookup.exitCode})`);
  }
  return readFile(sandbox, path);
}

export async function runRealAutomationAcceptance(): Promise<void> {
  console.log(`Real automation acceptance (${run.id})`);
  console.log(`  brain: ${BASE}`);
  console.log(`  session: ${sessionId}`);
  try {
  await run.preflight(BASE, { sandbox: true, requireLlm: true });

  const createSession = await postJson("/sessions", {
    id: sessionId,
    title: "real automation acceptance",
  });
  run.check(createSession.response.ok, "Brain session creation API");
  await store.insertMessage(
    sessionId,
    "user",
    `Real automation acceptance seed for ${run.id}; Dream must preserve this note.`,
  );

  console.log("\n[1] autoresearch API + PostgreSQL execution session");
  const start = await postJson("/agent/autoresearch/start", {
    chat_jid: sessionId,
    prompt: [
      "Run a real autoresearch experiment and keep working for at least 30 seconds.",
      "Do not fabricate results. Explore the request, make concrete progress, and report evidence.",
      "This is a live acceptance test; remain running until explicitly stopped.",
    ].join(" "),
  });
  run.check(start.response.ok && start.body.ok === true, "autoresearch start API");
  const startedRun = start.body.run as { id?: string; execution_session_id?: string; status?: string } | undefined;
  run.check(startedRun?.status === "running", "autoresearch starts in running state");
  run.check(Boolean(startedRun?.id), "autoresearch run has a database id");
  run.check(Boolean(startedRun?.execution_session_id), "autoresearch has an execution session id");
  if (startedRun?.execution_session_id) run.addResource("sessions", startedRun.execution_session_id);

  const dbRun = await store.getAutoresearchRunForSession(sessionId);
  run.check(dbRun?.id === startedRun?.id, "PostgreSQL autoresearch record persisted");
  run.check(dbRun?.execution_session_id === startedRun?.execution_session_id, "PostgreSQL execution session persisted");

  const runningStatus = await waitFor(
    async () => jsonFetch(`/agent/autoresearch/status?chat_jid=${encodeURIComponent(sessionId)}`),
    ({ body }) => body.key === "autoresearch" && statusPanelState(body) === "running",
    "autoresearch running status",
  );
  run.check(runningStatus.response.ok, "autoresearch status API reports running");

  const stop = await postJson("/agent/autoresearch/stop", { chat_jid: sessionId });
  run.check(stop.response.ok && stop.body.ok === true && stop.body.status === "stopped", "autoresearch stop API");
  const stopped = await waitFor(
    async () => jsonFetch(`/agent/autoresearch/status?chat_jid=${encodeURIComponent(sessionId)}`),
    ({ body }) => statusPanelState(body) === "stopped",
    "autoresearch stopped status",
  );
  run.check(stopped.response.ok, "autoresearch status API reports stopped");

  const dismiss = await postJson("/agent/autoresearch/dismiss", { chat_jid: sessionId });
  run.check(dismiss.response.ok && dismiss.body.ok === true && dismiss.body.dismissed === true, "autoresearch dismiss API");
  const dismissed = await jsonFetch(`/agent/autoresearch/status?chat_jid=${encodeURIComponent(sessionId)}`);
  run.check(dismissed.response.ok && dismissed.body === null, "autoresearch status is hidden after dismiss");

  const stoppedDbRun = await store.getAutoresearchRunForSession(sessionId);
  run.check(stoppedDbRun === null, "dismissed autoresearch record is hidden by live-session query");
  const storedRows = await sql`SELECT status, stop_requested_at, dismissed_at FROM autoresearch_runs WHERE id = ${startedRun?.id}`;
  run.check(
    storedRows[0]?.status === "stopped"
      && storedRows[0]?.stop_requested_at != null
      && storedRows[0]?.dismissed_at != null,
    "PostgreSQL autoresearch stop and dismiss timestamps persisted",
  );

  console.log("\n[2] scheduled task claim, Brain internal execute, and run log");
  await store.upsertScheduledTask({
    id: taskId,
    sessionId,
    prompt: "dream",
    scheduleType: "once",
    scheduleValue: new Date().toISOString(),
    // Claim APIs take the globally earliest due tasks. Put this isolated
    // acceptance task first without claiming any unrelated user tasks.
    nextRun: "1970-01-01T00:00:00.000Z",
    taskKind: "internal",
    status: "active",
  });
  run.addResource("tasks", taskId);
  const claimed = await store.claimDueScheduledTasks(10, 60_000);
  const claim = claimed.find((task) => task.id === taskId);
  run.check(Boolean(claim), "scheduled task is claimed from PostgreSQL");
  if (!claim) throw new Error("scheduled task claim missing");

  const executed = await postJson("/internal/scheduled-tasks/execute", claim);
  run.check(
    executed.response.ok && executed.body.ok === true,
    "Brain internal scheduled execute",
    `HTTP ${executed.response.status}: ${JSON.stringify(executed.body)}`,
  );
  const task = await waitFor(
    async () => store.getScheduledTaskById(taskId),
    (value) => value?.status === "completed" && value.claim_token === null,
    "scheduled task completion",
  );
  run.check(task?.status === "completed", "scheduled task completed after internal execution");
  const logs = await store.listTaskRunLogs(taskId);
  run.check(logs[0]?.status === "success", "scheduled task success run log persisted");

  console.log("\n[3] Dream next_run + real CubeSandbox maintenance notes");
  const dreamTask = await store.getScheduledTaskById(DREAM_TASK_ID);
  run.check(isValidIsoTimestamp(dreamTask?.next_run), "built-in Dream task next_run is a valid ISO timestamp");

  const memoryPath = `${WORKSPACE_ROOT}/notes/memory/MEMORY.md`;
  const memory = await readRequiredSandboxPath(memoryPath, "Dream MEMORY.md is readable from the real volume");
  const daily = await readDreamDailyNote().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    run.check(false, "Dream daily note is readable from the real volume", detail);
    throw error;
  });
  run.check(memory.includes("cloud Dream maintenance job"), "Dream wrote MEMORY.md to the real volume");
  run.check(daily.includes(sessionId), "Dream wrote daily maintenance notes to the real volume");
  } finally {
    try {
      const session = await store.getSession(sessionId).catch(() => null);
      if (session?.sandbox_id) run.addResource("sandboxes", session.sandbox_id);
      if (session?.workspace_volume_id) run.addResource("volumes", session.workspace_volume_id);
      await run.cleanup();
    } finally {
      const report = await run.writeReport();
      console.log(`report: ${report}`);
    }
  }
}

if (import.meta.main) await runRealAutomationAcceptance();
