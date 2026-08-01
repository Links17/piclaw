export function isAbortSteerSubmit(content: unknown, submitMode: unknown): boolean {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (!trimmed.startsWith('/abort')) return false;
  return submitMode === 'steer' || submitMode === 'compacting';
}

export function shouldRouteToQuestionAnswer(options: {
  baseContent: string;
  submitMode?: unknown;
  pendingQuestion?: { questionId?: string } | null;
  mediaIds?: unknown[];
}): boolean {
  const { baseContent, submitMode, pendingQuestion, mediaIds = [] } = options;
  if (isAbortSteerSubmit(baseContent, submitMode)) return false;
  return Boolean(pendingQuestion?.questionId && baseContent.trim() && mediaIds.length === 0);
}

export function isAgentAbortResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const payload = response as Record<string, unknown>;
  return payload.outcome === 'aborted';
}

export interface ApplyAgentAbortResponseOptions {
  clearAgentRunState: () => void;
  setAgentDraft: (next: { text: string; totalLines: number }) => void;
  setAgentStatus: (next: null) => void;
  setAgentPlan?: (next: string) => void;
  setAgentThought?: (next: { text: string; totalLines: number }) => void;
  clearCloudAgentQuestion?: () => void;
  wasAgentActiveRef?: { current: boolean };
}

export function applyOptimisticAgentAbort(options: ApplyAgentAbortResponseOptions): void {
  if (options.wasAgentActiveRef) {
    options.wasAgentActiveRef.current = false;
  }
  options.clearCloudAgentQuestion?.();
  options.clearAgentRunState();
  options.setAgentDraft({ text: '', totalLines: 0 });
  options.setAgentPlan?.('');
  options.setAgentThought?.({ text: '', totalLines: 0 });
  options.setAgentStatus(null);
}

export function applyAgentAbortResponse(
  response: unknown,
  options: ApplyAgentAbortResponseOptions,
): boolean {
  if (!isAgentAbortResponse(response)) return false;
  applyOptimisticAgentAbort(options);
  return true;
}
