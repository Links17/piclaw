import { Redis } from "ioredis";
import { config } from "../config.ts";

const commandRedis = new Redis(config.redisUrl);
const blockingRedis = new Redis(config.redisUrl);

function steerKey(runId: string): string {
  return `steer:${runId}`;
}

export async function enqueueSteerMessage(runId: string, message: string): Promise<void> {
  await commandRedis.lpush(steerKey(runId), message);
  await commandRedis.expire(steerKey(runId), 3600);
}

export async function pollSteerMessage(runId: string): Promise<string | null> {
  const result = await commandRedis.rpop(steerKey(runId));
  return result ? String(result) : null;
}

export async function clearSteerQueue(runId: string): Promise<void> {
  await commandRedis.del(steerKey(runId));
}

export async function waitForSubagentCompletion(
  sessionId: string,
  runId: string,
  timeoutMs: number,
): Promise<boolean> {
  const key = `subagent:done:${sessionId}:${runId}`;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await blockingRedis.brpop(key, timeoutSeconds);
  return Boolean(result);
}

export async function notifySubagentCompletion(sessionId: string, runId: string): Promise<void> {
  const key = `subagent:done:${sessionId}:${runId}`;
  await commandRedis.lpush(key, "done");
  await commandRedis.expire(key, 3600);
}
