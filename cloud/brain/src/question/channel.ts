import { Redis } from "ioredis";
import { config } from "../config.ts";

/** Non-blocking commands (LPUSH, EXPIRE, DEL). */
const commandRedis = new Redis(config.redisUrl);
/** Dedicated connection for BRPOP — must not share with commandRedis (ioredis deadlock). */
const blockingRedis = new Redis(config.redisUrl);

export const QUESTION_ABORT_SENTINEL = "__PICLAW_QUESTION_ABORT__";

function waitKey(sessionId: string, questionId: string): string {
  return `question:wait:${sessionId}:${questionId}`;
}

export function createQuestionId(): string {
  return `q-${crypto.randomUUID()}`;
}

export async function submitQuestionAnswer(
  sessionId: string,
  questionId: string,
  answer: string,
): Promise<boolean> {
  const key = waitKey(sessionId, questionId);
  const pushed = await commandRedis.lpush(key, answer);
  await commandRedis.expire(key, 3600);
  return pushed > 0;
}

export async function waitForQuestionAnswer(
  sessionId: string,
  questionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const key = waitKey(sessionId, questionId);
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await blockingRedis.brpop(key, timeoutSeconds);
  if (!result) return null;
  const answer = result[1];
  return answer ? String(answer) : null;
}

export async function abortQuestionWait(
  sessionId: string,
  questionId: string,
): Promise<void> {
  await submitQuestionAnswer(sessionId, questionId, QUESTION_ABORT_SENTINEL);
}

export async function clearQuestionWait(sessionId: string, questionId: string): Promise<void> {
  await commandRedis.del(waitKey(sessionId, questionId));
}
