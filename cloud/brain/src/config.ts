/** Brain service configuration. */
export const config = {
  pgUrl:
    process.env.CLOUD_PG_URL ||
    process.env.POC_PG_URL ||
    "postgres://sensecraft:sensecraft@localhost:25432/piclaw_cloud_poc",
  redisUrl: process.env.CLOUD_REDIS_URL || process.env.POC_REDIS_URL || "redis://localhost:26379/5",
  port: Number(process.env.CLOUD_PORT || process.env.POC_PORT || 7801),
  replicaId: process.env.CLOUD_REPLICA_ID || process.env.POC_REPLICA_ID || `replica-${process.pid}`,
  sweepIntervalMs: Number(process.env.CLOUD_SWEEP_INTERVAL_MS || process.env.POC_SWEEP_INTERVAL_MS || 2000),
  inflightGraceMs: Number(process.env.CLOUD_INFLIGHT_GRACE_MS || process.env.POC_INFLIGHT_GRACE_MS || 3000),
  maxInflightAgeMs: Number(
    process.env.CLOUD_MAX_INFLIGHT_AGE_MS || process.env.POC_MAX_INFLIGHT_AGE_MS || 10 * 60 * 1000,
  ),
  openaiBaseUrl: process.env.CLOUD_OPENAI_BASE_URL || process.env.POC_OPENAI_BASE_URL || "",
  openaiApiKey: process.env.CLOUD_OPENAI_API_KEY || process.env.POC_OPENAI_API_KEY || "",
  openaiModel: process.env.CLOUD_OPENAI_MODEL || process.env.POC_OPENAI_MODEL || "gpt-4o-mini",
  defaultChatJid: process.env.CLOUD_DEFAULT_CHAT_JID || "web:default",
  /** When false, bash:/PTY routes return a stub (turn-loop scenarios only). */
  sandboxEnabled: process.env.CLOUD_SANDBOX_ENABLED !== "0",
  maxToolRounds: Number(process.env.CLOUD_MAX_TOOL_ROUNDS || 12),
  /** Subagent / platform */
  authRequired: process.env.CLOUD_AUTH_REQUIRED === "1",
  devApiKey: process.env.CLOUD_DEV_API_KEY || "",
  subagentTimeoutMs: Number(process.env.CLOUD_SUBAGENT_TIMEOUT_MS || 5 * 60 * 1000),
  codingWorkerMode: (process.env.CLOUD_CODING_WORKER_MODE || "auto") as "auto" | "sandbox" | "brain" | "mock",
  maxActiveSandboxesPerUser: Number(process.env.CLOUD_MAX_ACTIVE_SANDBOXES || 3),
  maxDailyTokensPerUser: Number(process.env.CLOUD_MAX_DAILY_TOKENS || 500_000),
  sandboxIdleMs: Number(process.env.CLOUD_SANDBOX_IDLE_MS || 30 * 60 * 1000),
  workspacePollIntervalMs: Number(process.env.CLOUD_WORKSPACE_POLL_MS || 60_000),
};
