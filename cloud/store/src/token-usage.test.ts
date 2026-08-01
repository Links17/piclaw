import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import {
  allocateTokenAttempt,
  commitTurnUsage,
  commitCompaction,
  getCompactionBackoff,
  getDailyTokenUsageBreakdown,
  getLatestCompaction,
  getRecoverableAssistantUsage,
  getSessionTokenUsage,
  logTokenUsage,
  recordCompaction,
} from "./index.ts";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_ID = `usage-user-${suffix}`;
const SESSION_ID = `usage-session-${suffix}`;
let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`INSERT INTO users (id, display_name) VALUES (${USER_ID}, 'Usage Test')`;
    await sql`
      INSERT INTO sessions (id, user_id, title)
      VALUES (${SESSION_ID}, ${USER_ID}, 'Usage Test')`;
    await sql`INSERT INTO session_cursors (session_id) VALUES (${SESSION_ID})`;
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await sql`DELETE FROM sessions WHERE id = ${SESSION_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe("token usage accounting", () => {
  test("allocates monotonic provider attempts atomically for one operation and stage", async () => {
    if (!pgAvailable) return;
    const attempts = await Promise.all(Array.from({ length: 10 }, () =>
      allocateTokenAttempt({
        sessionId: SESSION_ID,
        source: "assistant",
        operationId: `turn:${SESSION_ID}:attempt-test`,
        stage: "provider_round",
      })
    ));
    expect([...attempts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  test("is idempotent by usage key and aggregates by source", async () => {
    if (!pgAvailable) return;
    const usage = {
      usageKey: `turn:${SESSION_ID}:1`,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: "assistant" as const,
      model: "test-model",
      provider: "test-provider",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
    };

    expect(await logTokenUsage(usage)).toBe(true);
    expect(await logTokenUsage(usage)).toBe(false);
    await logTokenUsage({
      ...usage,
      usageKey: `compaction:${SESSION_ID}:1`,
      source: "compaction",
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const aggregate = await getSessionTokenUsage(SESSION_ID);
    expect(aggregate.totals).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      totalTokens: 170,
      runs: 2,
    });
    expect(aggregate.bySource.assistant?.runs).toBe(1);
    expect(aggregate.bySource.compaction?.runs).toBe(1);
  });

  test("returns user daily input/output breakdown", async () => {
    if (!pgAvailable) return;
    const daily = await getDailyTokenUsageBreakdown(USER_ID);
    expect(daily.inputTokens).toBeGreaterThanOrEqual(140);
    expect(daily.outputTokens).toBeGreaterThanOrEqual(30);
    expect(daily.totalTokens).toBe(daily.inputTokens + daily.outputTokens);
  });

  test("atomically completes a turn and projects its assistant usage once under concurrency", async () => {
    if (!pgAvailable) return;
    const [userMessage] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'atomic turn')
      RETURNING id`;
    const userMessageId = Number(userMessage.id);
    const [assistantMessage] = await sql`
      INSERT INTO messages (session_id, role, content, content_blocks)
      VALUES (
        ${SESSION_ID},
        'assistant',
        'atomic answer',
        ${{
          usage_receipt: {
            version: 1,
            user_message_id: userMessageId,
            operation_id: `turn:${SESSION_ID}:${userMessageId}`,
            attempt: 1,
            provider: "test-provider",
            model: "test-model",
            input_tokens: 23,
            output_tokens: 11,
            reasoning_tokens: 7,
            cache_read_tokens: 5,
            cache_write_tokens: 3,
            status: "success",
          },
        }}::jsonb
      )
      RETURNING id`;
    const assistantMessageId = Number(assistantMessage.id);
    await sql`
      UPDATE session_cursors
      SET inflight_message_id = ${userMessageId}, inflight_started_at = now()
      WHERE session_id = ${SESSION_ID}`;
    const dailyBefore = await getDailyTokenUsageBreakdown(USER_ID);
    await logTokenUsage({
      usageKey: `turn:${SESSION_ID}:${userMessageId}:1`,
      sessionId: SESSION_ID,
      userId: USER_ID,
      messageId: assistantMessageId,
      source: "assistant",
      operationId: `turn:${SESSION_ID}:${userMessageId}`,
      attempt: 1,
      stage: "provider_round",
      provider: "test-provider",
      model: "test-model",
      inputTokens: 23,
      outputTokens: 11,
      reasoningTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      status: "success",
    });

    const results = await Promise.all(Array.from({ length: 10 }, () =>
      commitTurnUsage({
        sessionId: SESSION_ID,
        userId: USER_ID,
        userMessageId,
        assistantMessageId,
        provider: "test-provider",
        model: "test-model",
        inputTokens: 23,
        outputTokens: 11,
        reasoningTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        status: "success",
      })
    ));

    expect(results.every((result) => result.created)).toBe(true);
    const [cursor] = await sql`
      SELECT cursor_message_id, inflight_message_id
      FROM session_cursors WHERE session_id = ${SESSION_ID}`;
    expect(Number(cursor.cursor_message_id)).toBe(userMessageId);
    expect(cursor.inflight_message_id).toBeNull();
    const [ledger] = await sql`
      SELECT count(*)::int AS n, operation_id, status, reasoning_tokens
      FROM token_usage
      WHERE usage_key = ${`turn:${SESSION_ID}:${userMessageId}:1`}
      GROUP BY operation_id, status, reasoning_tokens`;
    expect(Number(ledger.n)).toBe(1);
    expect(ledger.operation_id).toBe(`turn:${SESSION_ID}:${userMessageId}`);
    expect(ledger.status).toBe("success");
    expect(Number(ledger.reasoning_tokens)).toBe(7);
    expect(await getRecoverableAssistantUsage(SESSION_ID, userMessageId)).toMatchObject({
      assistantMessageId,
      provider: "test-provider",
      model: "test-model",
      inputTokens: 23,
      outputTokens: 11,
      reasoningTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      status: "success",
    });
    const dailyAfter = await getDailyTokenUsageBreakdown(USER_ID);
    expect(dailyAfter.inputTokens - dailyBefore.inputTokens).toBe(23);
    expect(dailyAfter.outputTokens - dailyBefore.outputTokens).toBe(11);
  });
});

describe("persistent compaction", () => {
  test("stores one summary for a stable compacted boundary", async () => {
    if (!pgAvailable) return;
    const [message] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'old context')
      RETURNING id`;
    const messageId = Number(message.id);

    const first = await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: messageId,
      summary: "## Goal\nPreserve context.",
      tokensBefore: 90_000,
    });
    const second = await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: messageId,
      summary: "duplicate",
      tokensBefore: 90_000,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await getLatestCompaction(SESSION_ID))?.summary).toBe("## Goal\nPreserve context.");
  });

  test("returns the latest summary at or before a historical turn boundary", async () => {
    if (!pgAvailable) return;
    const inserted = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES
        (${SESSION_ID}, 'user', 'historical one'),
        (${SESSION_ID}, 'assistant', 'historical two'),
        (${SESSION_ID}, 'user', 'future three')
      RETURNING id`;
    const [first, second, future] = inserted.map((row: Record<string, unknown>) => Number(row.id));
    await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: first!,
      summary: "## Goal\nOld summary.",
      tokensBefore: 100,
    });
    await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: future!,
      summary: "## Goal\nFuture summary.",
      tokensBefore: 200,
    });

    expect((await getLatestCompaction(SESSION_ID, second))?.summary).toBe("## Goal\nOld summary.");
  });

  test("records compaction only while the expected turn remains inflight", async () => {
    if (!pgAvailable) return;
    const [message] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'conditional boundary')
      RETURNING id`;
    const messageId = Number(message.id);
    await sql`
      UPDATE session_cursors
      SET inflight_message_id = ${messageId}
      WHERE session_id = ${SESSION_ID}`;

    const created = await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: messageId,
      summary: "## Goal\nConditional summary.",
      tokensBefore: 300,
      expectedInflightMessageId: messageId,
    });
    const [laterMessage] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'assistant', 'later conditional boundary')
      RETURNING id`;
    await sql`
      UPDATE session_cursors
      SET inflight_message_id = NULL
      WHERE session_id = ${SESSION_ID}`;
    const rejected = await recordCompaction({
      sessionId: SESSION_ID,
      compactedThroughMessageId: Number(laterMessage.id),
      summary: "## Goal\nMust not persist.",
      tokensBefore: 400,
      expectedInflightMessageId: messageId,
    });

    expect(created.created).toBe(true);
    expect(rejected.created).toBe(false);
    expect(rejected.compaction).toBeNull();
  });

  test("atomically commits compaction, usage, daily projection, and clears backoff", async () => {
    if (!pgAvailable) return;
    const [message] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'atomic compaction')
      RETURNING id`;
    const messageId = Number(message.id);
    await sql`
      UPDATE session_cursors SET inflight_message_id = ${messageId}
      WHERE session_id = ${SESSION_ID}`;
    await sql`
      INSERT INTO session_compaction_backoffs (session_id, failure_count, retry_after, last_error)
      VALUES (${SESSION_ID}, 2, now() + interval '1 hour', 'old failure')
      ON CONFLICT (session_id) DO UPDATE SET
        failure_count = 2, retry_after = now() + interval '1 hour', last_error = 'old failure'`;
    const dailyBefore = await getDailyTokenUsageBreakdown(USER_ID);
    await logTokenUsage({
      usageKey: `compaction:${SESSION_ID}:${messageId}:1`,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: "compaction",
      operationId: `compaction:${messageId}`,
      attempt: 1,
      stage: "summary",
      model: "test-model",
      provider: "test-provider",
      inputTokens: 31,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      status: "success",
    });

    const committed = await commitCompaction({
      sessionId: SESSION_ID,
      userId: USER_ID,
      expectedInflightMessageId: messageId,
      compactedThroughMessageId: messageId,
      summary: "## Goal\nAtomic summary.",
      tokensBefore: 1_000,
      model: "test-model",
      inputTokens: 31,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    });

    expect(committed.created).toBe(true);
    expect(committed.compaction?.summary).toBe("## Goal\nAtomic summary.");
    expect((await getSessionTokenUsage(SESSION_ID)).bySource.compaction).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    const dailyAfter = await getDailyTokenUsageBreakdown(USER_ID);
    expect(dailyAfter.inputTokens - dailyBefore.inputTokens).toBe(31);
    expect(dailyAfter.outputTokens - dailyBefore.outputTokens).toBe(7);
    expect(await getCompactionBackoff(SESSION_ID)).toBeNull();
  });

  test("condition mismatch creates no artifacts and preserves backoff", async () => {
    if (!pgAvailable) return;
    const [message] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'rejected atomic compaction')
      RETURNING id`;
    const messageId = Number(message.id);
    await sql`
      UPDATE session_cursors SET inflight_message_id = NULL
      WHERE session_id = ${SESSION_ID}`;
    await sql`
      INSERT INTO session_compaction_backoffs (session_id, failure_count, retry_after, last_error)
      VALUES (${SESSION_ID}, 3, now() + interval '1 hour', 'keep me')
      ON CONFLICT (session_id) DO UPDATE SET
        failure_count = 3, retry_after = now() + interval '1 hour', last_error = 'keep me'`;
    const dailyBefore = await getDailyTokenUsageBreakdown(USER_ID);
    await logTokenUsage({
      usageKey: `compaction:${SESSION_ID}:${messageId}:1`,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: "compaction",
      operationId: `compaction:${messageId}`,
      attempt: 1,
      stage: "summary",
      model: "test-model",
      inputTokens: 17,
      outputTokens: 4,
      status: "success",
    });
    const usageBefore = await getSessionTokenUsage(SESSION_ID);
    const dailyAfterAttempt = await getDailyTokenUsageBreakdown(USER_ID);

    const rejected = await commitCompaction({
      sessionId: SESSION_ID,
      userId: USER_ID,
      expectedInflightMessageId: messageId,
      compactedThroughMessageId: messageId,
      summary: "## Goal\nMust not commit.",
      tokensBefore: 1_000,
      model: "test-model",
      inputTokens: 41,
      outputTokens: 9,
    });

    expect(rejected).toEqual({ created: false, compaction: null });
    expect(await getSessionTokenUsage(SESSION_ID)).toEqual(usageBefore);
    expect(await getDailyTokenUsageBreakdown(USER_ID)).toEqual(dailyAfterAttempt);
    expect(dailyAfterAttempt.totalTokens - dailyBefore.totalTokens).toBe(21);
    expect(await getCompactionBackoff(SESSION_ID)).toMatchObject({
      failureCount: 3,
      lastError: "keep me",
    });
  });

  test("replaying a boundary does not duplicate usage or daily projection", async () => {
    if (!pgAvailable) return;
    const [message] = await sql`
      INSERT INTO messages (session_id, role, content)
      VALUES (${SESSION_ID}, 'user', 'idempotent atomic compaction')
      RETURNING id`;
    const messageId = Number(message.id);
    await sql`
      UPDATE session_cursors SET inflight_message_id = ${messageId}
      WHERE session_id = ${SESSION_ID}`;
    const request = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      expectedInflightMessageId: messageId,
      compactedThroughMessageId: messageId,
      summary: "## Goal\nIdempotent summary.",
      tokensBefore: 1_000,
      model: "test-model",
      inputTokens: 17,
      outputTokens: 4,
    };
    const dailyBefore = await getDailyTokenUsageBreakdown(USER_ID);
    await logTokenUsage({
      usageKey: `compaction:${SESSION_ID}:${messageId}:1`,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: "compaction",
      operationId: `compaction:${messageId}`,
      attempt: 1,
      stage: "summary",
      model: "test-model",
      inputTokens: 17,
      outputTokens: 4,
      status: "success",
    });

    expect((await commitCompaction(request)).created).toBe(true);
    expect((await commitCompaction(request)).created).toBe(false);

    const dailyAfter = await getDailyTokenUsageBreakdown(USER_ID);
    expect(dailyAfter.inputTokens - dailyBefore.inputTokens).toBe(17);
    expect(dailyAfter.outputTokens - dailyBefore.outputTokens).toBe(4);
    const rows = await sql`
      SELECT count(*)::int AS n FROM token_usage
      WHERE usage_key = ${`compaction:${SESSION_ID}:${messageId}:1`}`;
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
