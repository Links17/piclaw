import * as defaultStore from "@piclaw-cloud/store";
import type {
  AutoresearchRunRow,
  AutoresearchStatus,
} from "@piclaw-cloud/store";
import { abortSessionTurn, submitMessage } from "../turn.ts";

export type { AutoresearchRunRow as AutoresearchRun, AutoresearchStatus } from "@piclaw-cloud/store";

export type AutoresearchStore = Pick<
  typeof defaultStore,
  "createSession" | "getAutoresearchRunForSession" | "createAutoresearchRun" | "updateAutoresearchRun"
>;

export type AbortAutoresearchExecution = (sessionId: string) => Promise<unknown> | unknown;

const BACKGROUND_PROMPT_PREFIX = "You are running an autoresearch experiment for the user.";
const backgroundRuns = new Map<string, Promise<void>>();

function buildBackgroundPrompt(prompt: string): string {
  return [
    BACKGROUND_PROMPT_PREFIX,
    "Work autonomously on the requested experiment. Make real progress, report evidence, and state any blockers honestly.",
    "",
    `Experiment request:\n${prompt}`,
  ].join("\n");
}

function toStatusPanel(run: AutoresearchRunRow) {
  const state = run.status === "completed" ? "completed" : run.status;
  const detail = run.error || run.summary || run.prompt;
  return {
    key: "autoresearch",
    content: [{
      type: "status_panel",
      panel: {
        key: "autoresearch",
        state,
        title: "Autoresearch",
        collapsed_text: state === "running" ? "Running experiment" : state,
        detail_markdown: detail,
        started_at: run.started_at,
        ...(run.finished_at ? { last_activity_at: run.finished_at } : {}),
        actions: state === "running"
          ? [{ key: "stop", action_type: "autoresearch.stop", label: "Stop", tone: "danger" }]
          : [{ key: "dismiss", action_type: "autoresearch.dismiss", label: "Dismiss" }],
      },
    }],
    options: { surface: "status-panel" },
  };
}

export async function getAutoresearchStatus(
  sessionId: string,
  store: AutoresearchStore = defaultStore,
) {
  const run = await store.getAutoresearchRunForSession(sessionId);
  if (!run || run.dismissed_at) return null;
  return toStatusPanel(run);
}

export async function startAutoresearch(input: {
  sessionId: string;
  userId: string;
  prompt: string;
  store?: AutoresearchStore;
  submit?: typeof submitMessage;
}): Promise<AutoresearchRunRow> {
  const store = input.store ?? defaultStore;
  const submit = input.submit ?? submitMessage;
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt required");

  const existing = await store.getAutoresearchRunForSession(input.sessionId);
  if (existing?.status === "running") {
    throw new Error("autoresearch is already running for this session");
  }

  const id = crypto.randomUUID();
  const executionSessionId = `autoresearch:${id}`;
  const startedAt = new Date().toISOString();
  const run: AutoresearchRunRow = {
    id,
    session_id: input.sessionId,
    execution_session_id: executionSessionId,
    prompt,
    status: "running",
    started_at: startedAt,
    finished_at: null,
    dismissed_at: null,
    stop_requested_at: null,
    summary: null,
    error: null,
  };
  await store.createSession(executionSessionId, "Autoresearch", input.userId);
  await store.createAutoresearchRun({
    id,
    sessionId: input.sessionId,
    executionSessionId,
    prompt,
    status: "running",
    startedAt,
  });

  const background = (async () => {
    try {
      await submit(executionSessionId, buildBackgroundPrompt(prompt));
      const current = await store.getAutoresearchRunForSession(input.sessionId);
      if (current?.id !== id || current.status !== "running") return;
      await store.updateAutoresearchRun(id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        summary: "Experiment turn completed.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await store.getAutoresearchRunForSession(input.sessionId);
      if (current?.id !== id || current.status !== "running") return;
      await store.updateAutoresearchRun(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: message,
      });
    } finally {
      backgroundRuns.delete(id);
    }
  })();
  backgroundRuns.set(id, background);
  return run;
}

export async function stopAutoresearch(
  sessionId: string,
  store: AutoresearchStore = defaultStore,
  abort: AbortAutoresearchExecution = abortSessionTurn,
): Promise<{ ok: boolean; status?: AutoresearchStatus; error?: string }> {
  const run = await store.getAutoresearchRunForSession(sessionId);
  if (!run) return { ok: false, error: "No autoresearch experiment found." };
  if (run.status !== "running") return { ok: false, status: run.status, error: "Autoresearch is not running." };

  const now = new Date().toISOString();
  await abort(run.execution_session_id);
  await store.updateAutoresearchRun(run.id, {
    status: "stopped",
    stopRequestedAt: now,
    finishedAt: now,
    summary: "Stopped by user.",
  });
  return { ok: true, status: "stopped" };
}

export async function dismissAutoresearch(
  sessionId: string,
  store: AutoresearchStore = defaultStore,
): Promise<{ ok: boolean; dismissed?: boolean; error?: string }> {
  const run = await store.getAutoresearchRunForSession(sessionId);
  if (!run) return { ok: false, error: "No autoresearch experiment found." };
  if (run.status === "running") return { ok: false, error: "Stop autoresearch before dismissing it." };
  await store.updateAutoresearchRun(run.id, { dismissedAt: new Date().toISOString() });
  return { ok: true, dismissed: true };
}

export function resetAutoresearchForTests(): void {
  backgroundRuns.clear();
}
