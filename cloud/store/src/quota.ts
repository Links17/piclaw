import { sql } from "./db.ts";

export interface QuotaLimits {
  maxActiveSandboxes: number;
  maxDailyTokens: number;
}

export interface QuotaCheckResult {
  ok: boolean;
  reason?: "active_sandbox_limit" | "daily_token_limit";
  activeSandboxes?: number;
  dailyTokens?: number;
}

export async function countActiveSandboxes(userId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM sessions
    WHERE user_id = ${userId}
      AND sandbox_id IS NOT NULL
      AND sandbox_paused_at IS NULL`;
  return Number(rows[0]?.n ?? 0);
}

export async function getDailyTokenUsage(userId: string): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS total
    FROM user_daily_usage
    WHERE user_id = ${userId} AND usage_date = CURRENT_DATE`;
  return Number(rows[0]?.total ?? 0);
}

export async function incrementDailyTokenUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await sql`
    INSERT INTO user_daily_usage (user_id, usage_date, input_tokens, output_tokens)
    VALUES (${userId}, CURRENT_DATE, ${inputTokens}, ${outputTokens})
    ON CONFLICT (user_id, usage_date) DO UPDATE SET
      input_tokens = user_daily_usage.input_tokens + EXCLUDED.input_tokens,
      output_tokens = user_daily_usage.output_tokens + EXCLUDED.output_tokens`;
}

export async function checkQuota(userId: string, limits: QuotaLimits): Promise<QuotaCheckResult> {
  const [activeSandboxes, dailyTokens] = await Promise.all([
    countActiveSandboxes(userId),
    getDailyTokenUsage(userId),
  ]);
  if (activeSandboxes >= limits.maxActiveSandboxes) {
    return { ok: false, reason: "active_sandbox_limit", activeSandboxes, dailyTokens };
  }
  if (dailyTokens >= limits.maxDailyTokens) {
    return { ok: false, reason: "daily_token_limit", activeSandboxes, dailyTokens };
  }
  return { ok: true, activeSandboxes, dailyTokens };
}
