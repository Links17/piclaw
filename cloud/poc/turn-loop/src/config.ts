/** PoC configuration — defaults point at the local docker services. */
export const config = {
  pgUrl: process.env.POC_PG_URL || "postgres://sensecraft:sensecraft@localhost:25432/piclaw_cloud_poc",
  redisUrl: process.env.POC_REDIS_URL || "redis://localhost:26379/5",
  port: Number(process.env.POC_PORT || 7801),
  replicaId: process.env.POC_REPLICA_ID || `replica-${process.pid}`,
  /** Sweep interval for inflight recovery scanning. */
  sweepIntervalMs: Number(process.env.POC_SWEEP_INTERVAL_MS || 2000),
  /** Inflight rows younger than this are assumed to still be running on a live replica. */
  inflightGraceMs: Number(process.env.POC_INFLIGHT_GRACE_MS || 3000),
  /** Inflight rows older than this are cleared without retry (MAX_INFLIGHT_AGE_MS analogue). */
  maxInflightAgeMs: Number(process.env.POC_MAX_INFLIGHT_AGE_MS || 10 * 60 * 1000),
  /** Optional OpenAI-compatible provider for real cache_read measurements. */
  openaiBaseUrl: process.env.POC_OPENAI_BASE_URL || "",
  openaiApiKey: process.env.POC_OPENAI_API_KEY || "",
  openaiModel: process.env.POC_OPENAI_MODEL || "gpt-4o-mini",
};

/** Namespace for advisory locks so we don't collide with other apps on the shared PG. */
export const LOCK_NAMESPACE = 91525;
