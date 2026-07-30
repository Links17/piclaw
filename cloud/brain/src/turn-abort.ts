/** Per-session turn abort flag — set by /abort, checked between tool rounds. */
export class TurnAbortedError extends Error {
  constructor(message = "Turn aborted by user") {
    super(message);
    this.name = "TurnAbortedError";
  }
}

const abortedSessions = new Set<string>();

export function beginTurnAbortScope(sessionId: string): void {
  abortedSessions.delete(sessionId);
}

export function clearTurnAbortScope(sessionId: string): void {
  abortedSessions.delete(sessionId);
}

export function signalTurnAbort(sessionId: string): void {
  abortedSessions.add(sessionId);
}

export function isTurnAborted(sessionId: string): boolean {
  return abortedSessions.has(sessionId);
}

export function assertTurnNotAborted(sessionId: string): void {
  if (isTurnAborted(sessionId)) {
    throw new TurnAbortedError();
  }
}
