import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";

const cloud = getCloudConfig();
function positiveEnvMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Brain service configuration. */
export const config = {
  pgUrl: cloud.pg.url,
  redisUrl: cloud.redis.url,
  port: cloud.server.port,
  replicaId: cloud.server.replicaId,
  sweepIntervalMs: cloud.server.sweepIntervalMs,
  inflightGraceMs: cloud.server.inflightGraceMs,
  maxInflightAgeMs: cloud.server.maxInflightAgeMs,
  openaiBaseUrl: cloud.openai.baseUrl,
  openaiApiKey: cloud.openai.apiKey,
  openaiModel: cloud.openai.model,
  openaiContextWindow: cloud.openai.contextWindow,
  openaiMaxTokens: cloud.openai.maxTokens,
  providers: cloud.providers ?? [],
  defaultChatJid: cloud.server.defaultChatJid,
  /** When false, bash:/PTY routes return a stub (turn-loop scenarios only). */
  sandboxEnabled: cloud.sandbox.enabled,
  maxToolRounds: cloud.limits.maxToolRounds,
  /** Subagent / platform */
  authRequired: cloud.auth.required,
  devApiKey: cloud.auth.devApiKey,
  schedulerServiceKey: cloud.scheduler.serviceKey,
  drainTimeoutMs: positiveEnvMs("CLOUD_DRAIN_TIMEOUT_MS", 30_000),
  subagentTimeoutMs: cloud.subagent.timeoutMs,
  codingWorkerMode: cloud.subagent.codingWorkerMode,
  maxActiveSandboxesPerUser: cloud.subagent.maxActiveSandboxesPerUser,
  maxDailyTokensPerUser: cloud.limits.maxDailyTokensPerUser,
  sandboxIdleMs: cloud.sandbox.idleMs,
  workspacePollIntervalMs: cloud.server.workspacePollIntervalMs,
  questionTimeoutMs: cloud.question.timeoutMs,
  subagentMaxConcurrent: cloud.subagentMaxConcurrent,
  subagentMaxTurns: cloud.subagentMaxTurns,
  webAllowedOrigins: cloud.web?.allowedOrigins ?? [],
};
