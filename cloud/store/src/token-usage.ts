import { sql } from "./db.ts";

export type TokenUsageSource = "assistant" | "side_prompt" | "subagent" | "compaction";
export type TokenUsageStatus = "success" | "error" | "aborted" | "failed" | "timed_out" | "stopped";

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  runs: number;
}

export interface LatestTokenUsage extends TokenUsageSummary {
  source: TokenUsageSource;
  model: string | null;
  provider: string | null;
  createdAt: string;
}

export async function allocateTokenAttempt(input: {
  sessionId: string;
  source: TokenUsageSource;
  operationId: string;
  stage: string;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO token_attempt_counters (
      session_id, usage_source, operation_id, stage, last_attempt
    ) VALUES (
      ${input.sessionId}, ${input.source}, ${input.operationId}, ${input.stage}, 1
    )
    ON CONFLICT (session_id, usage_source, operation_id, stage)
    DO UPDATE SET last_attempt = token_attempt_counters.last_attempt + 1
    RETURNING last_attempt`;
  return number(rows[0]?.last_attempt);
}

export interface SessionTokenUsage {
  totals: TokenUsageSummary;
  latest: LatestTokenUsage | null;
  bySource: Partial<Record<TokenUsageSource, TokenUsageSummary>>;
}

export interface CompactionRow {
  id: number;
  sessionId: string;
  compactedThroughMessageId: number;
  summary: string;
  tokensBefore: number;
  createdAt: string;
}

export interface CommitCompactionInput {
  sessionId: string;
  userId: string;
  expectedInflightMessageId: number;
  compactedThroughMessageId: number;
  summary: string;
  tokensBefore: number;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}

export interface CommitTurnUsageInput {
  sessionId: string;
  userId: string;
  userMessageId: number;
  assistantMessageId: number;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  status?: TokenUsageStatus;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function summary(row: Record<string, unknown> | undefined): TokenUsageSummary {
  return {
    inputTokens: number(row?.input_tokens),
    outputTokens: number(row?.output_tokens),
    reasoningTokens: number(row?.reasoning_tokens),
    cacheReadTokens: number(row?.cache_read_tokens),
    cacheWriteTokens: number(row?.cache_write_tokens),
    totalTokens: number(row?.total_tokens),
    runs: number(row?.runs),
  };
}

export async function logTokenUsage(row: {
  usageKey?: string;
  sessionId: string;
  userId?: string;
  messageId?: number;
  source?: TokenUsageSource;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  operationId?: string;
  attempt?: number;
  status?: TokenUsageStatus;
  subagentRunId?: string;
  stage?: string;
}): Promise<boolean> {
  const totalTokens = row.inputTokens + row.outputTokens + (row.reasoningTokens ?? 0);
  const rows = await sql`
    WITH owner AS (
      SELECT user_id
      FROM sessions
      WHERE id = ${row.sessionId}
        AND (${row.userId ?? null}::text IS NULL OR user_id = ${row.userId ?? null})
    ),
    inserted AS (
      INSERT INTO token_usage (
        usage_key, session_id, user_id, message_id, usage_source, model, provider,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, duration_ms
        , operation_id, attempt, status, subagent_run_id, stage
      )
      SELECT
        ${row.usageKey ?? null}, ${row.sessionId}, owner.user_id, ${row.messageId ?? null},
        ${row.source ?? "assistant"}, ${row.model ?? null}, ${row.provider ?? null},
        ${row.inputTokens}, ${row.outputTokens}, ${row.reasoningTokens ?? 0},
        ${row.cacheReadTokens ?? 0}, ${row.cacheWriteTokens ?? 0},
        ${totalTokens}, ${row.durationMs ?? null},
        ${row.operationId ?? null}, ${row.attempt ?? null}, ${row.status ?? "success"},
        ${row.subagentRunId ?? null}, ${row.stage ?? null}
      FROM owner
      ON CONFLICT DO NOTHING
      RETURNING user_id, input_tokens, output_tokens
    ),
    daily AS (
      INSERT INTO user_daily_usage (user_id, usage_date, input_tokens, output_tokens)
      SELECT user_id, CURRENT_DATE, input_tokens, output_tokens FROM inserted
      ON CONFLICT (user_id, usage_date) DO UPDATE SET
        input_tokens = user_daily_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens = user_daily_usage.output_tokens + EXCLUDED.output_tokens
      RETURNING 1
    )
    SELECT EXISTS(SELECT 1 FROM inserted) AS inserted`;
  return Boolean(rows[0]?.inserted);
}

export async function commitTurnUsage(
  row: CommitTurnUsageInput,
): Promise<{ created: boolean }> {
  const operationId = `turn:${row.sessionId}:${row.userMessageId}`;
  return sql.begin(async (tx) => {
    const cursors = await tx`
      SELECT 1
      FROM session_cursors c
      JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = ${row.sessionId}
        AND s.user_id = ${row.userId}
        AND (
          c.inflight_message_id = ${row.userMessageId}
          OR c.cursor_message_id = ${row.userMessageId}
        )
      FOR UPDATE OF c`;
    if (!cursors[0]) return { created: false };

    const assistant = await tx`
      SELECT 1 FROM messages
      WHERE id = ${row.assistantMessageId}
        AND session_id = ${row.sessionId}
        AND role = 'assistant'`;
    if (!assistant[0]) throw new Error(`assistant message ${row.assistantMessageId} not found`);

    const usage = await tx`
      SELECT count(*)::int AS n
      FROM token_usage
      WHERE session_id = ${row.sessionId}
        AND operation_id = ${operationId}
        AND usage_source = 'assistant'`;
    if (Number(usage[0]?.n ?? 0) === 0) {
      throw new Error(`turn usage ledger missing for ${operationId}`);
    }

    await tx`
      UPDATE session_cursors SET
        cursor_message_id = ${row.userMessageId},
        inflight_prev_cursor = NULL,
        inflight_message_id = NULL,
        inflight_started_at = NULL,
        failed_message_id = NULL,
        failed_at = NULL,
        failed_error = NULL
      WHERE session_id = ${row.sessionId}`;
    return { created: Number(usage[0]?.n ?? 0) > 0 };
  });
}

export interface AssistantUsageReceipt {
  assistantMessageId: number;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  status: TokenUsageStatus;
  version: number;
  userMessageId: number;
  operationId: string;
  attempt: number;
}

export async function getRecoverableAssistantUsage(
  sessionId: string,
  userMessageId: number,
): Promise<AssistantUsageReceipt | null> {
  const rows = await sql`
    SELECT id, content_blocks
    FROM messages
    WHERE session_id = ${sessionId}
      AND role = 'assistant'
      AND id > ${userMessageId}
      AND COALESCE(content_blocks, '{}'::jsonb) ? 'usage_receipt'
    ORDER BY id DESC
    LIMIT 1`;
  const row = rows[0];
  const receipt = row?.content_blocks?.usage_receipt as Record<string, unknown> | undefined;
  if (!row || !receipt) return null;
  const inputTokens = nonnegativeInteger(receipt.input_tokens);
  const outputTokens = nonnegativeInteger(receipt.output_tokens);
  const reasoningTokens = nonnegativeInteger(receipt.reasoning_tokens);
  const cacheReadTokens = nonnegativeInteger(receipt.cache_read_tokens);
  const cacheWriteTokens = nonnegativeInteger(receipt.cache_write_tokens);
  const status = String(receipt.status ?? "");
  if (
    number(receipt.version) !== 1
    || number(receipt.user_message_id) !== userMessageId
    || String(receipt.operation_id ?? "") !== `turn:${sessionId}:${userMessageId}`
    || number(receipt.attempt) <= 0
    || inputTokens == null
    || outputTokens == null
    || reasoningTokens == null
    || cacheReadTokens == null
    || cacheWriteTokens == null
    || !["success", "error", "aborted", "failed", "timed_out", "stopped"].includes(status)
  ) return null;
  return {
    assistantMessageId: number(row.id),
    provider: receipt.provider == null ? null : String(receipt.provider),
    model: receipt.model == null ? null : String(receipt.model),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    status: status as TokenUsageStatus,
    version: 1,
    userMessageId,
    operationId: String(receipt.operation_id),
    attempt: number(receipt.attempt),
  };
}

export async function persistAssistantUsageReceipt(input: {
  sessionId: string;
  assistantMessageId: number;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status?: TokenUsageStatus;
  userMessageId: number;
  operationId: string;
  attempt: number;
}): Promise<void> {
  await sql`
    UPDATE messages
    SET content_blocks = COALESCE(content_blocks, '{}'::jsonb) || jsonb_build_object(
      'usage_receipt',
      jsonb_build_object(
        'version', 1,
        'user_message_id', ${input.userMessageId}::bigint,
        'operation_id', ${input.operationId}::text,
        'attempt', ${input.attempt}::int,
        'provider', ${input.provider ?? null}::text,
        'model', ${input.model ?? null}::text,
        'input_tokens', ${input.inputTokens}::int,
        'output_tokens', ${input.outputTokens}::int,
        'reasoning_tokens', ${input.reasoningTokens ?? 0}::int,
        'cache_read_tokens', ${input.cacheReadTokens ?? 0}::int,
        'cache_write_tokens', ${input.cacheWriteTokens ?? 0}::int,
        'status', ${input.status ?? "success"}::text
      )
    )
    WHERE id = ${input.assistantMessageId}
      AND session_id = ${input.sessionId}
      AND role = 'assistant'`;
}

export async function persistAssistantUsageReceiptFromLedger(input: {
  sessionId: string;
  assistantMessageId: number;
  userMessageId: number;
  operationId: string;
}): Promise<void> {
  const rows = await sql`
    SELECT
      CASE WHEN COUNT(DISTINCT provider) FILTER (WHERE provider IS NOT NULL) = 1
        THEN MIN(provider) ELSE NULL END AS provider,
      CASE WHEN COUNT(DISTINCT model) FILTER (WHERE model IS NOT NULL) = 1
        THEN MIN(model) ELSE NULL END AS model,
      COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
      MAX(attempt)::int AS attempt
    FROM token_usage
    WHERE session_id = ${input.sessionId}
      AND usage_source = 'assistant'
      AND operation_id = ${input.operationId}
    `;
  const row = rows[0];
  if (!row) throw new Error(`turn usage ledger missing for ${input.operationId}`);
  await persistAssistantUsageReceipt({
    ...input,
    provider: row.provider == null ? undefined : String(row.provider),
    model: row.model == null ? undefined : String(row.model),
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    reasoningTokens: number(row.reasoning_tokens),
    cacheReadTokens: number(row.cache_read_tokens),
    cacheWriteTokens: number(row.cache_write_tokens),
    attempt: number(row.attempt),
    status: "success",
  });
}

export interface SidePromptStoredResult {
  status: "success" | "error";
  result: string | null;
  thinking: string | null;
  error?: string;
  model: string | null;
  operationId?: string;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens?: number | null;
    cacheWriteTokens?: number | null;
  };
  stopReason?: string;
}

export async function claimSidePromptOperation(input: {
  sessionId: string;
  operationId: string;
  promptHash: string;
  leaseMs?: number;
}): Promise<
  | { state: "claimed"; ownerToken: string }
  | { state: "running" }
  | { state: "completed"; result: SidePromptStoredResult }
> {
  const ownerToken = crypto.randomUUID();
  const inserted = await sql`
    INSERT INTO side_prompt_operations (
      session_id, operation_id, prompt_hash, lease_expires_at, owner_token
    )
    VALUES (
      ${input.sessionId}, ${input.operationId}, ${input.promptHash},
      now() + make_interval(secs => ${Math.max(1, input.leaseMs ?? 300_000) / 1000}),
      ${ownerToken}
    )
    ON CONFLICT (session_id, operation_id) DO NOTHING
    RETURNING 1`;
  if (inserted[0]) return { state: "claimed", ownerToken };
  const rows = await sql`
    SELECT prompt_hash, status, result
    FROM side_prompt_operations
    WHERE session_id = ${input.sessionId}
      AND operation_id = ${input.operationId}`;
  const row = rows[0];
  if (!row) return { state: "running" };
  if (String(row.prompt_hash) !== input.promptHash) {
    throw new Error(`side prompt operation ${input.operationId} was reused with a different prompt`);
  }
  if (row.status === "completed" && row.result) {
    return { state: "completed", result: row.result as SidePromptStoredResult };
  }
  const reclaimedOwnerToken = crypto.randomUUID();
  const reclaimed = await sql`
    UPDATE side_prompt_operations
    SET lease_expires_at = now() + make_interval(secs => ${Math.max(1, input.leaseMs ?? 300_000) / 1000}),
        owner_token = ${reclaimedOwnerToken},
        updated_at = now()
    WHERE session_id = ${input.sessionId}
      AND operation_id = ${input.operationId}
      AND status = 'running'
      AND lease_expires_at <= now()
    RETURNING 1`;
  if (reclaimed[0]) return { state: "claimed", ownerToken: reclaimedOwnerToken };
  return { state: "running" };
}

export async function getSidePromptOperationResult(
  sessionId: string,
  operationId: string,
): Promise<SidePromptStoredResult | null> {
  const rows = await sql`
    SELECT result FROM side_prompt_operations
    WHERE session_id = ${sessionId}
      AND operation_id = ${operationId}
      AND status = 'completed'`;
  return rows[0]?.result ? rows[0].result as SidePromptStoredResult : null;
}

export async function renewSidePromptOperation(input: {
  sessionId: string;
  operationId: string;
  ownerToken: string;
  leaseMs: number;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE side_prompt_operations
    SET lease_expires_at = now() + make_interval(secs => ${Math.max(1, input.leaseMs) / 1000}),
        updated_at = now()
    WHERE session_id = ${input.sessionId}
      AND operation_id = ${input.operationId}
      AND status = 'running'
      AND owner_token = ${input.ownerToken}
    RETURNING 1`;
  return Boolean(rows[0]);
}

export async function recordOrphanedSidePromptUsage(input: {
  sessionId: string;
  userId: string;
  operationId: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: TokenUsageStatus;
}): Promise<boolean> {
  const attempt = await allocateTokenAttempt({
    sessionId: input.sessionId,
    source: "side_prompt",
    operationId: input.operationId,
    stage: "orphaned_provider_usage",
  });
  return logTokenUsage({
    usageKey: `side_prompt:${input.sessionId}:${input.operationId}:orphan:${attempt}`,
    ...input,
    source: "side_prompt",
    attempt,
    stage: "orphaned_provider_usage",
  });
}

export async function finishSidePromptOperation(input: {
  sessionId: string;
  operationId: string;
  result: SidePromptStoredResult;
  ownerToken: string;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE side_prompt_operations
    SET status = 'completed', result = ${JSON.stringify(input.result)}::jsonb, updated_at = now()
    WHERE session_id = ${input.sessionId}
      AND operation_id = ${input.operationId}
      AND status = 'running'
      AND owner_token = ${input.ownerToken}
      AND lease_expires_at > now()
    RETURNING 1`;
  return Boolean(rows[0]);
}

export async function completeSidePromptOperation(input: {
  sessionId: string;
  userId: string;
  operationId: string;
  result: SidePromptStoredResult;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: TokenUsageStatus;
  reservationId?: string;
  reservationOwnerToken?: string;
  reservationGeneration?: number;
  ownerToken: string;
}): Promise<boolean> {
  const usageKey = `side_prompt:${input.sessionId}:${input.operationId}`;
  const totalTokens = input.inputTokens + input.outputTokens + (input.reasoningTokens ?? 0);
  return sql.begin(async (tx) => {
    const operation = await tx`
      SELECT 1
      FROM side_prompt_operations o
      JOIN sessions s ON s.id = o.session_id
      WHERE o.session_id = ${input.sessionId}
        AND o.operation_id = ${input.operationId}
        AND s.user_id = ${input.userId}
        AND o.status = 'running'
        AND o.owner_token = ${input.ownerToken}
        AND o.lease_expires_at > now()
      FOR UPDATE OF o`;
    if (!operation[0]) throw new Error("side prompt operation access denied");
    const usage = await tx`
      INSERT INTO token_usage (
        usage_key, session_id, user_id, usage_source, model, provider,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens,
        operation_id, attempt, status, stage
      ) VALUES (
        ${usageKey}, ${input.sessionId}, ${input.userId}, 'side_prompt',
        ${input.model ?? null}, ${input.provider ?? null},
        ${input.inputTokens}, ${input.outputTokens}, ${input.reasoningTokens ?? 0},
        ${input.cacheReadTokens ?? 0}, ${input.cacheWriteTokens ?? 0}, ${totalTokens},
        ${input.operationId}, 1, ${input.status}, 'provider_round'
      )
      ON CONFLICT (usage_key) WHERE usage_key IS NOT NULL DO NOTHING
      RETURNING input_tokens, output_tokens`;
    if (usage[0]) {
      await tx`
        INSERT INTO user_daily_usage (user_id, usage_date, input_tokens, output_tokens)
        VALUES (${input.userId}, CURRENT_DATE, ${input.inputTokens}, ${input.outputTokens})
        ON CONFLICT (user_id, usage_date) DO UPDATE SET
          input_tokens = user_daily_usage.input_tokens + EXCLUDED.input_tokens,
          output_tokens = user_daily_usage.output_tokens + EXCLUDED.output_tokens`;
    }
    await tx`
      UPDATE side_prompt_operations
      SET status = 'completed', result = ${JSON.stringify(input.result)}::jsonb, updated_at = now()
      WHERE session_id = ${input.sessionId} AND operation_id = ${input.operationId}
        AND owner_token = ${input.ownerToken} AND lease_expires_at > now()`;
    if (input.reservationId) {
      await tx`
        UPDATE token_reservations SET
          status = 'settled',
          actual_input_tokens = ${input.inputTokens},
          actual_output_tokens = ${input.outputTokens},
          settled_at = now()
        WHERE id = ${input.reservationId} AND status = 'active'
          AND owner_token = ${input.reservationOwnerToken ?? null}
          AND generation = ${input.reservationGeneration ?? null}`;
    }
    return Boolean(usage[0]);
  });
}

export interface SubagentCompletionUsageEntry {
  usageKey: string;
  operationId: string;
  attempt: number;
  stage: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: TokenUsageStatus;
}

export async function completeSubagentInvocation(input: {
  sessionId: string;
  userId: string;
  runId: string;
  invocationId: string;
  ownerToken: string;
  generation: number;
  status: "completed" | "failed" | "timed_out" | "stopped";
  summary: string;
  artifacts: string[];
  error?: string | null;
  usageEntries: SubagentCompletionUsageEntry[];
}): Promise<void> {
  await sql.begin(async (tx) => {
    const runs = await tx`
      SELECT 1
      FROM subagent_runs r
      JOIN sessions s ON s.id = r.session_id
      JOIN subagent_invocations i ON i.run_id = r.id
      WHERE r.id = ${input.runId}
        AND r.session_id = ${input.sessionId}
        AND s.user_id = ${input.userId}
        AND i.id = ${input.invocationId}
        AND i.status = 'running'
        AND i.owner_token = ${input.ownerToken}
        AND i.generation = ${input.generation}
        AND i.lease_expires_at > now()
      FOR UPDATE OF r, i`;
    if (!runs[0]) throw new Error("subagent invocation completion denied");

    let addedInput = 0;
    let addedOutput = 0;
    for (const entry of input.usageEntries) {
      const total = entry.inputTokens + entry.outputTokens + (entry.reasoningTokens ?? 0);
      const inserted = await tx`
        INSERT INTO token_usage (
          usage_key, session_id, user_id, usage_source, model, provider,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens,
          operation_id, attempt, status, subagent_run_id, stage
        ) VALUES (
          ${entry.usageKey}, ${input.sessionId}, ${input.userId}, 'subagent',
          ${entry.model ?? null}, ${entry.provider ?? null},
          ${entry.inputTokens}, ${entry.outputTokens}, ${entry.reasoningTokens ?? 0},
          ${entry.cacheReadTokens ?? 0}, ${entry.cacheWriteTokens ?? 0}, ${total},
          ${entry.operationId}, ${entry.attempt}, ${entry.status}, ${input.runId}, ${entry.stage}
        )
        ON CONFLICT (usage_key) WHERE usage_key IS NOT NULL DO NOTHING
        RETURNING input_tokens, output_tokens`;
      if (inserted[0]) {
        addedInput += Number(inserted[0].input_tokens);
        addedOutput += Number(inserted[0].output_tokens);
      }
    }
    if (addedInput > 0 || addedOutput > 0) {
      await tx`
        INSERT INTO user_daily_usage (user_id, usage_date, input_tokens, output_tokens)
        VALUES (${input.userId}, CURRENT_DATE, ${addedInput}, ${addedOutput})
        ON CONFLICT (user_id, usage_date) DO UPDATE SET
          input_tokens = user_daily_usage.input_tokens + EXCLUDED.input_tokens,
          output_tokens = user_daily_usage.output_tokens + EXCLUDED.output_tokens`;
    }
    const invocationTotals = await tx`
      SELECT
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
      FROM token_usage
      WHERE subagent_run_id = ${input.runId}
        AND operation_id = ${input.invocationId}`;
    const invocationInput = Number(invocationTotals[0]?.input_tokens ?? 0);
    const invocationOutput = Number(invocationTotals[0]?.output_tokens ?? 0);
    await tx`
      UPDATE subagent_runs SET
        status = ${input.status},
        summary = ${input.summary},
        artifacts = ${JSON.stringify(input.artifacts)}::jsonb,
        error = ${input.error ?? null},
        input_tokens = (
          SELECT COALESCE(SUM(input_tokens), 0)::bigint
          FROM token_usage WHERE subagent_run_id = ${input.runId}
        ),
        output_tokens = (
          SELECT COALESCE(SUM(output_tokens), 0)::bigint
          FROM token_usage WHERE subagent_run_id = ${input.runId}
        ),
        finished_at = now()
      WHERE id = ${input.runId}`;
    await tx`
      UPDATE subagent_invocations
      SET status = ${input.status}, finished_at = now()
      WHERE id = ${input.invocationId}
        AND owner_token = ${input.ownerToken}
        AND generation = ${input.generation}
        AND lease_expires_at > now()`;
  });
}

export async function getSessionTokenUsage(sessionId: string): Promise<SessionTokenUsage> {
  const [totalsRows, latestRows, sourceRows] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COUNT(*)::bigint AS runs
      FROM token_usage WHERE session_id = ${sessionId}`,
    sql`
      SELECT usage_source, model, provider, input_tokens, output_tokens,
        reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        created_at, 1::bigint AS runs
      FROM token_usage
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    sql`
      SELECT usage_source,
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COUNT(*)::bigint AS runs
      FROM token_usage
      WHERE session_id = ${sessionId}
      GROUP BY usage_source`,
  ]);
  const bySource: SessionTokenUsage["bySource"] = {};
  for (const sourceRow of sourceRows) {
    bySource[String(sourceRow.usage_source) as TokenUsageSource] = summary(sourceRow);
  }
  const latestRow = latestRows[0];
  return {
    totals: summary(totalsRows[0]),
    latest: latestRow
      ? {
          ...summary(latestRow),
          source: String(latestRow.usage_source) as TokenUsageSource,
          model: latestRow.model == null ? null : String(latestRow.model),
          provider: latestRow.provider == null ? null : String(latestRow.provider),
          createdAt: String(latestRow.created_at),
        }
      : null,
    bySource,
  };
}

export async function getSessionTokenUsageForUser(
  sessionId: string,
  userId: string,
): Promise<SessionTokenUsage | null> {
  const owner = await sql`
    SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`;
  if (!owner[0]) return null;
  return getSessionTokenUsage(sessionId);
}

export async function getDailyTokenUsageBreakdown(userId: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}> {
  const rows = await sql`
    SELECT COALESCE(input_tokens, 0) AS input_tokens,
      COALESCE(output_tokens, 0) AS output_tokens
    FROM user_daily_usage
    WHERE user_id = ${userId} AND usage_date = CURRENT_DATE`;
  const inputTokens = number(rows[0]?.input_tokens);
  const outputTokens = number(rows[0]?.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export async function recordCompaction(row: {
  sessionId: string;
  compactedThroughMessageId: number;
  summary: string;
  tokensBefore: number;
  expectedInflightMessageId?: number;
}): Promise<{ created: boolean; compaction: CompactionRow | null }> {
  const rows = await sql`
    INSERT INTO session_compactions (
      session_id, compacted_through_message_id, summary, tokens_before
    )
    SELECT ${row.sessionId}, ${row.compactedThroughMessageId}, ${row.summary}, ${row.tokensBefore}
    WHERE ${row.expectedInflightMessageId ?? null}::bigint IS NULL
      OR EXISTS (
        SELECT 1
        FROM session_cursors
        WHERE session_id = ${row.sessionId}
          AND inflight_message_id = ${row.expectedInflightMessageId ?? null}
      )
    ON CONFLICT (session_id, compacted_through_message_id) DO NOTHING
    RETURNING id, session_id, compacted_through_message_id, summary, tokens_before, created_at`;
  const created = rows.length > 0;
  const stored = created
    ? rows[0]
    : (await sql`
        SELECT id, session_id, compacted_through_message_id, summary, tokens_before, created_at
        FROM session_compactions
        WHERE session_id = ${row.sessionId}
          AND compacted_through_message_id = ${row.compactedThroughMessageId}`)[0];
  if (!stored) return { created: false, compaction: null };
  return {
    created,
    compaction: {
      id: number(stored.id),
      sessionId: String(stored.session_id),
      compactedThroughMessageId: number(stored.compacted_through_message_id),
      summary: String(stored.summary),
      tokensBefore: number(stored.tokens_before),
      createdAt: String(stored.created_at),
    },
  };
}

function compactionRow(row: Record<string, unknown>): CompactionRow {
  return {
    id: number(row.id),
    sessionId: String(row.session_id),
    compactedThroughMessageId: number(row.compacted_through_message_id),
    summary: String(row.summary),
    tokensBefore: number(row.tokens_before),
    createdAt: String(row.created_at),
  };
}

export async function commitCompaction(
  row: CommitCompactionInput,
): Promise<{ created: boolean; compaction: CompactionRow | null }> {
  return sql.begin(async (tx) => {
    const cursors = await tx`
      SELECT s.user_id
      FROM session_cursors c
      JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = ${row.sessionId}
        AND c.inflight_message_id = ${row.expectedInflightMessageId}
        AND s.user_id = ${row.userId}
      FOR UPDATE OF c`;
    if (!cursors[0]) return { created: false, compaction: null };

    const inserted = await tx`
      INSERT INTO session_compactions (
        session_id, compacted_through_message_id, summary, tokens_before
      ) VALUES (
        ${row.sessionId}, ${row.compactedThroughMessageId}, ${row.summary}, ${row.tokensBefore}
      )
      ON CONFLICT (session_id, compacted_through_message_id) DO NOTHING
      RETURNING id, session_id, compacted_through_message_id, summary, tokens_before, created_at`;
    if (inserted.length === 0) {
      const existing = await tx`
        SELECT id, session_id, compacted_through_message_id, summary, tokens_before, created_at
        FROM session_compactions
        WHERE session_id = ${row.sessionId}
          AND compacted_through_message_id = ${row.compactedThroughMessageId}`;
      return {
        created: false,
        compaction: existing[0] ? compactionRow(existing[0]) : null,
      };
    }

    const stillInflight = await tx`
      SELECT 1
      FROM session_cursors
      WHERE session_id = ${row.sessionId}
        AND inflight_message_id = ${row.expectedInflightMessageId}`;
    if (!stillInflight[0]) {
      throw new Error("compaction inflight condition changed during transaction");
    }

    const attempts = await tx`
      SELECT count(*)::int AS n
      FROM token_usage
      WHERE session_id = ${row.sessionId}
        AND usage_source = 'compaction'
        AND operation_id = ${`compaction:${row.compactedThroughMessageId}`}
        AND attempt IS NOT NULL`;
    if (Number(attempts[0]?.n ?? 0) === 0) {
      throw new Error(`compaction attempt ledger missing for boundary ${row.compactedThroughMessageId}`);
    }
    await tx`
      DELETE FROM session_compaction_backoffs
      WHERE session_id = ${row.sessionId}`;

    return { created: true, compaction: compactionRow(inserted[0]) };
  });
}

export async function getLatestCompaction(
  sessionId: string,
  throughMessageId?: number,
): Promise<CompactionRow | null> {
  const rows = await sql`
    SELECT id, session_id, compacted_through_message_id, summary, tokens_before, created_at
    FROM session_compactions
    WHERE session_id = ${sessionId}
      AND (${throughMessageId ?? null}::bigint IS NULL
        OR compacted_through_message_id <= ${throughMessageId ?? null})
    ORDER BY compacted_through_message_id DESC, id DESC
    LIMIT 1`;
  const row = rows[0];
  return row
    ? {
        id: number(row.id),
        sessionId: String(row.session_id),
        compactedThroughMessageId: number(row.compacted_through_message_id),
        summary: String(row.summary),
        tokensBefore: number(row.tokens_before),
        createdAt: String(row.created_at),
      }
    : null;
}

export async function getCompactionBackoff(sessionId: string): Promise<{
  failureCount: number;
  retryAfter: string | null;
  lastError: string | null;
} | null> {
  const rows = await sql`
    SELECT failure_count, retry_after, last_error
    FROM session_compaction_backoffs WHERE session_id = ${sessionId}`;
  const row = rows[0];
  return row
    ? {
        failureCount: number(row.failure_count),
        retryAfter: row.retry_after == null ? null : String(row.retry_after),
        lastError: row.last_error == null ? null : String(row.last_error),
      }
    : null;
}

export async function recordCompactionFailure(
  sessionId: string,
  error: string,
  baseMinutes: number,
  maxMinutes: number,
): Promise<void> {
  await sql`
    INSERT INTO session_compaction_backoffs (
      session_id, failure_count, retry_after, last_error
    ) VALUES (
      ${sessionId}, 1, now() + make_interval(mins => ${baseMinutes}), ${error}
    )
    ON CONFLICT (session_id) DO UPDATE SET
      failure_count = session_compaction_backoffs.failure_count + 1,
      retry_after = now() + make_interval(
        mins => LEAST(
          ${maxMinutes},
          ${baseMinutes} * power(2, session_compaction_backoffs.failure_count)
        )::int
      ),
      last_error = EXCLUDED.last_error,
      updated_at = now()`;
}

export async function clearCompactionBackoff(sessionId: string): Promise<void> {
  await sql`DELETE FROM session_compaction_backoffs WHERE session_id = ${sessionId}`;
}

export async function getPlatformUsageMetrics(): Promise<{
  tokensToday: number;
  activeSandboxes: number;
  inflightTurns: number;
  scheduledTaskBacklog: number;
}> {
  const [tokens, sandboxes, turns, tasks] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS n
      FROM user_daily_usage WHERE usage_date = CURRENT_DATE`,
    sql`
      SELECT COUNT(*)::bigint AS n FROM sessions
      WHERE sandbox_id IS NOT NULL AND sandbox_paused_at IS NULL`,
    sql`
      SELECT COUNT(*)::bigint AS n FROM session_cursors
      WHERE inflight_message_id IS NOT NULL`,
    sql`
      SELECT COUNT(*)::bigint AS n FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= now()`,
  ]);
  return {
    tokensToday: number(tokens[0]?.n),
    activeSandboxes: number(sandboxes[0]?.n),
    inflightTurns: number(turns[0]?.n),
    scheduledTaskBacklog: number(tasks[0]?.n),
  };
}
