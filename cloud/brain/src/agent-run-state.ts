/**
 * In-memory agent run preview state for /agent/status polling (classic Web UI).
 */
import type { PendingQuestion } from "./question/state.ts";

const inflightTurns = new Map<string, string>();
const draftText = new Map<string, string>();
const planText = new Map<string, string>();
const pendingQuestions = new Map<string, PendingQuestion>();

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

export function setPlanPreview(sessionId: string, text: string): void {
  planText.set(sessionId, text);
}

export function getPlanPreview(sessionId: string): string {
  return planText.get(sessionId) ?? "";
}

export function setPendingQuestionState(sessionId: string, pending: PendingQuestion): void {
  pendingQuestions.set(sessionId, pending);
}

export function getPendingQuestionState(sessionId: string): PendingQuestion | null {
  return pendingQuestions.get(sessionId) ?? null;
}

export function clearPendingQuestionState(sessionId: string): void {
  pendingQuestions.delete(sessionId);
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

export interface ContextUsageSnapshot {
  tokens: number;
  contextWindow: number;
  percent: number;
}

const contextUsage = new Map<string, ContextUsageSnapshot>();

export function setContextUsage(sessionId: string, snapshot: ContextUsageSnapshot): void {
  contextUsage.set(sessionId, snapshot);
}

export function getContextUsage(sessionId: string): ContextUsageSnapshot | null {
  return contextUsage.get(sessionId) ?? null;
}
