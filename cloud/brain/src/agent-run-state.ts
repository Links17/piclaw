/**
 * In-memory agent run preview state for /agent/status polling (classic Web UI).
 */
const inflightTurns = new Map<string, string>();
const draftText = new Map<string, string>();

export function setInflightTurn(sessionId: string, turnId: string): void {
  inflightTurns.set(sessionId, turnId);
  draftText.set(sessionId, "");
}

export function clearInflightTurn(sessionId: string): void {
  inflightTurns.delete(sessionId);
  draftText.delete(sessionId);
}

export function getInflightTurn(sessionId: string): string | null {
  return inflightTurns.get(sessionId) ?? null;
}

export function appendDraft(sessionId: string, delta: string): void {
  draftText.set(sessionId, (draftText.get(sessionId) ?? "") + delta);
}

export function getDraft(sessionId: string): string {
  return draftText.get(sessionId) ?? "";
}

export function trackTurnStarted(sessionId: string, messageId: number): void {
  setInflightTurn(sessionId, String(messageId));
}

export function trackTurnDelta(sessionId: string, delta: string): void {
  appendDraft(sessionId, delta);
}

export function trackTurnFinished(sessionId: string): void {
  clearInflightTurn(sessionId);
}
