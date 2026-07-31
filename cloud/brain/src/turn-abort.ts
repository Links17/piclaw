/** Per-session turn abort flag — set by /abort, checked between tool rounds. */
export class TurnAbortedError extends Error {
  constructor(message = "Turn aborted by user") {
    super(message);
    this.name = "TurnAbortedError";
  }
}

const abortedSessions = new Set<string>();
const llmAbortControllers = new Map<string, AbortController>();
const abortWaiters = new Map<string, Set<() => void>>();

export function beginTurnAbortScope(sessionId: string): AbortController {
  abortedSessions.delete(sessionId);
  llmAbortControllers.get(sessionId)?.abort();
  const controller = new AbortController();
  llmAbortControllers.set(sessionId, controller);
  return controller;
}

export function clearTurnAbortScope(sessionId: string): void {
  abortedSessions.delete(sessionId);
  llmAbortControllers.delete(sessionId);
  abortWaiters.delete(sessionId);
}

export function getTurnAbortSignal(sessionId: string): AbortSignal | undefined {
  return llmAbortControllers.get(sessionId)?.signal;
}

function notifyAbortWaiters(sessionId: string): void {
  const waiters = abortWaiters.get(sessionId);
  if (!waiters) return;
  for (const resolve of waiters) resolve();
  abortWaiters.delete(sessionId);
}

export function signalTurnAbort(sessionId: string): void {
  abortedSessions.add(sessionId);
  llmAbortControllers.get(sessionId)?.abort();
  notifyAbortWaiters(sessionId);
}

export function isTurnAborted(sessionId: string): boolean {
  return abortedSessions.has(sessionId);
}

export function assertTurnNotAborted(sessionId: string): void {
  if (isTurnAborted(sessionId)) {
    throw new TurnAbortedError();
  }
}

export function waitForTurnAbort(sessionId: string): Promise<void> {
  if (isTurnAborted(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    let waiters = abortWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Set();
      abortWaiters.set(sessionId, waiters);
    }
    waiters.add(resolve);
  });
}

export function throwIfAborted(sessionId: string, signal?: AbortSignal): void {
  if (signal?.aborted || isTurnAborted(sessionId)) {
    throw new TurnAbortedError();
  }
}
