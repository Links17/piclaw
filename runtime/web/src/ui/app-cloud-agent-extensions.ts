type Listener = () => void;

export interface CloudAgentQuestion {
  questionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

export interface SubagentTranscriptMessage {
  id?: number;
  role: string;
  content: string;
  toolName?: string;
}

export interface CloudFleetRun {
  runId: string;
  agentType: string;
  description: string;
  status: string;
  task?: string;
  summary?: string;
  toolCount?: number;
  currentActivity?: string;
  deltaPreview?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  liveMessages?: SubagentTranscriptMessage[];
}

const FINISHED_LINGER_MS = 8000;
const MAX_DELTA_PREVIEW = 240;
const MAX_LIVE_MESSAGES = 80;

let agentQuestion: CloudAgentQuestion | null = null;
let fleetRuns: CloudFleetRun[] = [];
const listeners = new Set<Listener>();
const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function isTerminalStatus(status: string): boolean {
  return ['completed', 'failed', 'timed_out', 'stopped', 'cancelled'].includes(status);
}

function scheduleFleetRunPrune(runId: string): void {
  const existing = pruneTimers.get(runId);
  if (existing) clearTimeout(existing);
  pruneTimers.set(
    runId,
    setTimeout(() => {
      pruneTimers.delete(runId);
      fleetRuns = fleetRuns.filter((run) => run.runId !== runId);
      emit();
    }, FINISHED_LINGER_MS),
  );
}

function cancelFleetRunPrune(runId: string): void {
  const existing = pruneTimers.get(runId);
  if (existing) {
    clearTimeout(existing);
    pruneTimers.delete(runId);
  }
}

function defaultFleetRun(update: Partial<CloudFleetRun> & { runId: string }): CloudFleetRun {
  return {
    runId: update.runId,
    agentType: update.agentType ?? 'general-purpose',
    description: update.description ?? '',
    status: update.status ?? 'pending',
    task: update.task,
    summary: update.summary,
    toolCount: update.toolCount,
    currentActivity: update.currentActivity,
    deltaPreview: update.deltaPreview,
    startedAt: update.startedAt ?? null,
    finishedAt: update.finishedAt ?? null,
    liveMessages: update.liveMessages ?? [],
  };
}

export function subscribeCloudAgentExtensions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCloudAgentQuestion(): CloudAgentQuestion | null {
  return agentQuestion;
}

export function setCloudAgentQuestion(next: CloudAgentQuestion | null): void {
  agentQuestion = next;
  emit();
}

export function getCloudFleetRuns(): CloudFleetRun[] {
  return fleetRuns;
}

export function upsertCloudFleetRun(update: Partial<CloudFleetRun> & { runId: string }): void {
  if (!update.runId) return;
  const index = fleetRuns.findIndex((run) => run.runId === update.runId);
  const prev = index >= 0 ? fleetRuns[index] : null;
  const nextStatus = update.status ?? prev?.status ?? 'pending';
  const merged = index < 0
    ? defaultFleetRun(update)
    : { ...prev!, ...update };

  if (!merged.startedAt && ['running', 'steered'].includes(nextStatus)) {
    merged.startedAt = new Date().toISOString();
  }
  if (!merged.finishedAt && isTerminalStatus(nextStatus)) {
    merged.finishedAt = new Date().toISOString();
  }

  if (index < 0) {
    fleetRuns = [...fleetRuns, merged];
  } else {
    fleetRuns = fleetRuns.map((run, idx) => (idx === index ? merged : run));
  }

  if (isTerminalStatus(nextStatus)) {
    scheduleFleetRunPrune(update.runId);
  } else {
    cancelFleetRunPrune(update.runId);
  }

  emit();
}

export function appendSubagentDelta(runId: string, delta: string): void {
  if (!runId || !delta) return;
  const index = fleetRuns.findIndex((run) => run.runId === runId);
  if (index < 0) return;
  const run = fleetRuns[index];
  const combined = `${run.deltaPreview ?? ''}${delta}`;
  fleetRuns = fleetRuns.map((entry, idx) => (
    idx === index
      ? {
          ...entry,
          deltaPreview: combined.slice(-MAX_DELTA_PREVIEW),
          currentActivity: entry.currentActivity || 'thinking…',
        }
      : entry
  ));
  emit();
}

export function setSubagentActivity(runId: string, activity: string): void {
  if (!runId) return;
  upsertCloudFleetRun({ runId, currentActivity: activity });
}

export function appendLiveSubagentMessage(runId: string, message: SubagentTranscriptMessage): void {
  if (!runId || !message?.content) return;
  const index = fleetRuns.findIndex((run) => run.runId === runId);
  if (index < 0) {
    upsertCloudFleetRun({
      runId,
      status: 'running',
      description: message.content.slice(0, 80),
      liveMessages: [message],
    });
    return;
  }
  const run = fleetRuns[index];
  const liveMessages = [...(run.liveMessages ?? []), message].slice(-MAX_LIVE_MESSAGES);
  fleetRuns = fleetRuns.map((entry, idx) => (idx === index ? { ...entry, liveMessages } : entry));
  emit();
}

export function hydrateFleetRunsFromApi(
  runs: Array<Record<string, unknown>>,
): void {
  if (!Array.isArray(runs) || runs.length === 0) return;
  for (const row of runs) {
    const runId = String(row.run_id ?? row.runId ?? '').trim();
    if (!runId) continue;
    const status = String(row.status ?? 'pending');
    upsertCloudFleetRun({
      runId,
      agentType: String(row.agent_type ?? row.agentType ?? 'general-purpose'),
      description: String(row.description ?? row.task ?? runId),
      status,
      task: typeof row.task === 'string' ? row.task : undefined,
      summary: typeof row.summary === 'string' ? row.summary : undefined,
      toolCount: typeof row.tool_count === 'number' ? row.tool_count : undefined,
      startedAt: typeof row.started_at === 'string' ? row.started_at : null,
      finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
    });
  }
}

export function clearCloudAgentExtensions(): void {
  agentQuestion = null;
  fleetRuns = [];
  for (const timer of pruneTimers.values()) clearTimeout(timer);
  pruneTimers.clear();
  emit();
}
