export interface PendingQuestion {
  questionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  createdAt: number;
}

const pendingBySession = new Map<string, PendingQuestion>();

export function setPendingQuestion(sessionId: string, pending: PendingQuestion): void {
  pendingBySession.set(sessionId, pending);
}

export function getPendingQuestion(sessionId: string): PendingQuestion | null {
  return pendingBySession.get(sessionId) ?? null;
}

export function clearPendingQuestion(sessionId: string): void {
  pendingBySession.delete(sessionId);
}
