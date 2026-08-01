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

export interface SandboxQuotaReservation {
  reserved: boolean;
  activeSandboxes: number;
}

export interface TokenBudgetReservation {
  reserved: boolean;
  reservationId?: string;
  dailyTokens: number;
  reservedTokens: number;
  ownerToken?: string;
  generation?: number;
  acquired?: boolean;
}

export async function reserveTokenBudget(input: {
  userId: string;
  operationId: string;
  estimatedTokens: number;
  maxDailyTokens: number;
  leaseMs: number;
  ownerToken?: string;
}): Promise<TokenBudgetReservation> {
  return sql.begin(async (tx) => {
    const users = await tx`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
    if (!users[0]) throw new Error(`unknown user ${input.userId}`);
    await tx`
      UPDATE token_reservations
      SET status = 'expired'
      WHERE user_id = ${input.userId}
        AND status = 'active'
        AND lease_expires_at <= now()`;
    const existing = await tx`
      SELECT id, estimated_tokens, status, owner_token, generation
      FROM token_reservations
      WHERE user_id = ${input.userId}
        AND operation_id = ${input.operationId}`;
    if (existing[0]) {
      if (existing[0].status !== "active") {
        const dailyTokens = await dailyTokensTx(tx, input.userId);
        const active = await tx`
          SELECT COALESCE(SUM(estimated_tokens), 0)::bigint AS total
          FROM token_reservations
          WHERE user_id = ${input.userId} AND status = 'active'`;
        const reservedTokens = Number(active[0]?.total ?? 0);
        if (dailyTokens + reservedTokens + input.estimatedTokens > input.maxDailyTokens) {
          return { reserved: false, dailyTokens, reservedTokens };
        }
        const ownerToken = input.ownerToken ?? crypto.randomUUID();
        const reactivated = await tx`
          UPDATE token_reservations SET
            status = 'active',
            estimated_tokens = ${Math.max(0, Math.floor(input.estimatedTokens))},
            actual_input_tokens = 0,
            actual_output_tokens = 0,
            owner_token = ${ownerToken},
            generation = generation + 1,
            lease_expires_at = now() + make_interval(secs => ${Math.max(1, input.leaseMs) / 1000}),
            settled_at = NULL
          WHERE id = ${existing[0].id}
          RETURNING generation`;
        return {
          reserved: true,
          reservationId: String(existing[0].id),
          ownerToken,
          generation: Number(reactivated[0].generation),
          acquired: true,
          dailyTokens,
          reservedTokens: reservedTokens + input.estimatedTokens,
        };
      }
      return {
        reserved: true,
        reservationId: String(existing[0].id),
        ...(input.ownerToken && input.ownerToken === String(existing[0].owner_token)
          ? { ownerToken: input.ownerToken }
          : {}),
        generation: Number(existing[0].generation),
        acquired: Boolean(input.ownerToken && input.ownerToken === String(existing[0].owner_token)),
        dailyTokens: await dailyTokensTx(tx, input.userId),
        reservedTokens: Number(existing[0].estimated_tokens),
      };
    }
    const dailyTokens = await dailyTokensTx(tx, input.userId);
    const active = await tx`
      SELECT COALESCE(SUM(estimated_tokens), 0)::bigint AS total
      FROM token_reservations
      WHERE user_id = ${input.userId} AND status = 'active'`;
    const reservedTokens = Number(active[0]?.total ?? 0);
    if (dailyTokens + reservedTokens + input.estimatedTokens > input.maxDailyTokens) {
      return { reserved: false, dailyTokens, reservedTokens };
    }
    const reservationId = `tokres-${crypto.randomUUID()}`;
    const ownerToken = input.ownerToken ?? crypto.randomUUID();
    await tx`
      INSERT INTO token_reservations (
        id, user_id, operation_id, estimated_tokens, lease_expires_at, owner_token
      ) VALUES (
        ${reservationId}, ${input.userId}, ${input.operationId},
        ${Math.max(0, Math.floor(input.estimatedTokens))},
        now() + make_interval(secs => ${Math.max(1, input.leaseMs) / 1000}),
        ${ownerToken}
      )`;
    return {
      reserved: true,
      reservationId,
      ownerToken,
      generation: 1,
      acquired: true,
      dailyTokens,
      reservedTokens: reservedTokens + input.estimatedTokens,
    };
  });
}

async function dailyTokensTx(
  tx: typeof sql,
  userId: string,
): Promise<number> {
  const rows = await tx`
    SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS total
    FROM user_daily_usage
    WHERE user_id = ${userId} AND usage_date = CURRENT_DATE`;
  return Number(rows[0]?.total ?? 0);
}

export async function settleTokenBudget(input: {
  reservationId: string;
  ownerToken: string;
  generation: number;
  actualInputTokens: number;
  actualOutputTokens: number;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE token_reservations SET
      status = 'settled',
      actual_input_tokens = ${Math.max(0, input.actualInputTokens)},
      actual_output_tokens = ${Math.max(0, input.actualOutputTokens)},
      settled_at = now()
    WHERE id = ${input.reservationId} AND status = 'active'
      AND owner_token = ${input.ownerToken}
      AND generation = ${input.generation}
    RETURNING 1`;
  return Boolean(rows[0]);
}

export async function releaseTokenBudget(input: {
  reservationId: string;
  ownerToken: string;
  generation: number;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE token_reservations
    SET status = 'released', settled_at = now()
    WHERE id = ${input.reservationId} AND status = 'active'
      AND owner_token = ${input.ownerToken}
      AND generation = ${input.generation}
    RETURNING 1`;
  return Boolean(rows[0]);
}

export async function countActiveSandboxes(userId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM sessions
    WHERE user_id = ${userId}
      AND sandbox_id IS NOT NULL
      AND sandbox_paused_at IS NULL`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Atomically claim this session's active sandbox slot. The user row lock
 * serializes competing claims without coupling quota ownership to a process.
 */
export async function reserveSandboxQuota(
  sessionId: string,
  maxActiveSandboxes: number,
): Promise<SandboxQuotaReservation> {
  return sql.begin(async (tx) => {
    const sessions = await tx`
      SELECT s.user_id, s.sandbox_id, s.sandbox_paused_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sessionId}
      FOR UPDATE OF s, u`;
    const session = sessions[0];
    if (!session) throw new Error(`unknown session ${sessionId}`);

    if (session.sandbox_id === `quota-reservation:${sessionId}`) {
      const active = await tx`
        SELECT count(*)::int AS n FROM sessions
        WHERE user_id = ${session.user_id}
          AND sandbox_id IS NOT NULL
          AND sandbox_paused_at IS NULL`;
      return { reserved: false, activeSandboxes: Number(active[0]?.n ?? 0) };
    }

    if (session.sandbox_id && session.sandbox_paused_at == null) {
      const active = await tx`
        SELECT count(*)::int AS n FROM sessions
        WHERE user_id = ${session.user_id}
          AND sandbox_id IS NOT NULL
          AND sandbox_paused_at IS NULL`;
      return { reserved: true, activeSandboxes: Number(active[0]?.n ?? 0) };
    }

    const active = await tx`
      SELECT count(*)::int AS n FROM sessions
      WHERE user_id = ${session.user_id}
        AND sandbox_id IS NOT NULL
        AND sandbox_paused_at IS NULL`;
    const activeSandboxes = Number(active[0]?.n ?? 0);
    if (activeSandboxes >= maxActiveSandboxes) {
      return { reserved: false, activeSandboxes };
    }

    await tx`
      UPDATE sessions
      SET sandbox_id = ${`quota-reservation:${sessionId}`},
          sandbox_paused_at = NULL,
          updated_at = now()
      WHERE id = ${sessionId}`;
    return { reserved: true, activeSandboxes: activeSandboxes + 1 };
  });
}

/** Releases a provisional slot when sandbox creation cannot complete. */
export async function releaseSandboxQuotaReservation(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions
    SET sandbox_id = NULL, sandbox_paused_at = NULL, updated_at = now()
    WHERE id = ${sessionId}
      AND sandbox_id = ${`quota-reservation:${sessionId}`}`;
}

export async function getDailyTokenUsage(userId: string): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS total
    FROM user_daily_usage
    WHERE user_id = ${userId} AND usage_date = CURRENT_DATE`;
  return Number(rows[0]?.total ?? 0);
}

/** Legacy direct increment for tests/admin quota seeding. Runtime LLM paths use logTokenUsage. */
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
