import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { fetchSubagentTranscript, steerSubagentRun, stopSubagentRun } from '../api.js';
import { renderThinkingMarkdown } from '../markdown.js';
import type { CloudFleetRun, SubagentTranscriptMessage } from '../ui/app-cloud-agent-extensions.js';

function statusIcon(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed' || status === 'timed_out' || status === 'stopped' || status === 'cancelled') return '✗';
  if (status === 'running' || status === 'steered') return '◌';
  if (status === 'queued' || status === 'pending') return '■';
  return '•';
}

function formatElapsed(startedAt: string | null | undefined, finishedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function activityLine(run: CloudFleetRun): string | null {
  if (run.currentActivity) return run.currentActivity;
  if (run.status === 'completed' && run.summary) return run.summary.slice(0, 120);
  if (run.deltaPreview) return run.deltaPreview.slice(-80);
  if (run.status === 'running') return 'working…';
  return null;
}

function normalizeApiMessages(payload: unknown): SubagentTranscriptMessage[] {
  const messages = (payload as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.map((row) => {
    const record = row as Record<string, unknown>;
    const blocks = record.content_blocks as Record<string, unknown> | null | undefined;
    return {
      id: typeof record.id === 'number' ? record.id : undefined,
      role: String(record.role ?? 'unknown'),
      content: String(record.content ?? ''),
      toolName: typeof blocks?.tool_name === 'string' ? blocks.tool_name : undefined,
    };
  });
}

function renderTranscriptMessage(message: SubagentTranscriptMessage) {
  const label = message.role === 'tool' && message.toolName
    ? `tool · ${message.toolName}`
    : message.role;
  return html`
    <div class="agent-subagent-transcript-entry" key=${`${message.id ?? label}-${message.content.slice(0, 24)}`}>
      <div class="agent-subagent-transcript-role">${label}</div>
      <div class="agent-subagent-transcript-content">${renderThinkingMarkdown(message.content)}</div>
    </div>
  `;
}

export function AgentSubagentPanel({
  runs,
  chatJid,
}: {
  runs: CloudFleetRun[];
  chatJid: string;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [transcriptByRun, setTranscriptByRun] = useState<Record<string, SubagentTranscriptMessage[]>>({});
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);

  const visibleRuns = runs.filter((run) => run.runId);
  if (visibleRuns.length === 0) return null;

  const selectedRun = selectedRunId
    ? visibleRuns.find((run) => run.runId === selectedRunId) ?? null
    : null;

  useEffect(() => {
    if (!selectedRunId || !chatJid) return;
    let cancelled = false;
    void fetchSubagentTranscript(chatJid, selectedRunId)
      .then((payload) => {
        if (cancelled) return;
        setTranscriptByRun((prev) => ({
          ...prev,
          [selectedRunId]: normalizeApiMessages(payload),
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setTranscriptByRun((prev) => ({ ...prev, [selectedRunId]: prev[selectedRunId] ?? [] }));
      });
    return () => { cancelled = true; };
  }, [selectedRunId, chatJid, selectedRun?.status, selectedRun?.toolCount]);

  async function submitSteer() {
    if (!selectedRunId || !steerText.trim() || steering) return;
    setSteering(true);
    try {
      await steerSubagentRun(chatJid, selectedRunId, steerText.trim());
      setSteerText('');
    } finally {
      setSteering(false);
    }
  }

  const queuedCount = visibleRuns.filter((run) => run.status === 'queued' || run.status === 'pending').length;
  const selectedMessages = selectedRunId
    ? [
        ...(transcriptByRun[selectedRunId] ?? []),
        ...(visibleRuns.find((run) => run.runId === selectedRunId)?.liveMessages ?? []),
      ]
    : [];

  return html`
    <div class="agent-thinking agent-thinking-subagents" data-testid="agent-subagent-panel" data-no-chat-swipe="true" aria-live="polite">
      <div class="agent-thinking-title thought">
        <span class="turn-dot" aria-hidden="true"></span>
        Agents (${visibleRuns.length})
      </div>
      <div class="agent-thinking-body agent-subagent-body">
        <ul class="agent-subagent-list" role="list">
          ${visibleRuns.map((run) => {
            const elapsed = formatElapsed(run.startedAt, run.finishedAt);
            const activity = activityLine(run);
            const isSelected = selectedRunId === run.runId;
            const isRunning = run.status === 'running' || run.status === 'steered';
            return html`
              <li class=${`agent-subagent-row${isSelected ? ' is-selected' : ''}${isRunning ? ' is-running' : ''}`} key=${run.runId}>
                <button
                  type="button"
                  class="agent-subagent-select"
                  data-no-chat-swipe="true"
                  aria-expanded=${isSelected}
                  onClick=${() => setSelectedRunId(isSelected ? null : run.runId)}
                >
                  <span class="agent-subagent-status" aria-hidden="true">${statusIcon(run.status)}</span>
                  <span class="agent-subagent-main">
                    <span class="agent-subagent-title-row">
                      <span class="agent-subagent-type">${run.agentType}</span>
                      <span class="agent-subagent-desc">${run.description || run.task || run.runId}</span>
                    </span>
                    <span class="agent-subagent-meta">
                      ${run.toolCount != null ? html`<span>${run.toolCount} tools</span>` : null}
                      ${elapsed ? html`<span>${elapsed}</span>` : null}
                      <span class="agent-subagent-run-id">${run.runId.slice(0, 18)}…</span>
                    </span>
                    ${activity && html`<span class="agent-subagent-activity">⎿ ${activity}</span>`}
                  </span>
                </button>
                ${isSelected && isRunning && html`
                  <div class="agent-subagent-actions">
                    <button
                      type="button"
                      class="agent-thinking-action-btn danger"
                      data-no-chat-swipe="true"
                      onClick=${() => void stopSubagentRun(chatJid, run.runId)}
                    >
                      Stop
                    </button>
                  </div>
                `}
              </li>
            `;
          })}
        </ul>
        ${queuedCount > 0 && html`<p class="agent-subagent-queued">${queuedCount} queued</p>`}
        ${selectedRun && html`
          <div class="agent-subagent-transcript">
            ${selectedMessages.length > 0
              ? selectedMessages.map(renderTranscriptMessage)
              : html`<p class="agent-subagent-transcript-empty">No transcript yet — live activity will appear here.</p>`}
            ${(selectedRun.status === 'running' || selectedRun.status === 'steered') && html`
              <div class="agent-subagent-steer">
                <input
                  type="text"
                  class="agent-subagent-steer-input"
                  data-no-chat-swipe="true"
                  placeholder="Steer this agent…"
                  value=${steerText}
                  disabled=${steering}
                  onInput=${(event: Event) => setSteerText((event.target as HTMLInputElement).value)}
                  onKeyDown=${(event: KeyboardEvent) => {
                    if (event.key === 'Enter') void submitSteer();
                  }}
                />
                <button
                  type="button"
                  class="agent-thinking-action-btn"
                  data-no-chat-swipe="true"
                  disabled=${!steerText.trim() || steering}
                  onClick=${() => void submitSteer()}
                >
                  Steer
                </button>
              </div>
            `}
          </div>
        `}
      </div>
    </div>
  `;
}
