import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import {
  claimSubagentInvocation,
  completeSubagentInvocation,
  createSubagentRunIfCapacity,
  createSubagentRun,
  getSubagentRun,
} from "./index.ts";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_A = `subagent-owner-a-${suffix}`;
const USER_B = `subagent-owner-b-${suffix}`;
const SESSION_A = `subagent-session-a-${suffix}`;
const SESSION_B = `subagent-session-b-${suffix}`;
const RUN_ID = `subagent-run-${suffix}`;
const CAPACITY_RUN_ID = `subagent-capacity-${suffix}`;
let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`
      INSERT INTO users (id, display_name)
      VALUES (${USER_A}, 'Owner A'), (${USER_B}, 'Owner B')`;
    await sql`
      INSERT INTO sessions (id, user_id, title)
      VALUES (${SESSION_A}, ${USER_A}, 'A'), (${SESSION_B}, ${USER_B}, 'B')`;
    await createSubagentRun({ id: RUN_ID, sessionId: SESSION_A, task: "test" });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await sql`DELETE FROM sessions WHERE id IN (${SESSION_A}, ${SESSION_B})`;
  await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
});

describe("subagent invocation claims", () => {
  test("rejects cross-session and cross-user resume", async () => {
    if (!pgAvailable) return;
    await expect(claimSubagentInvocation({
      runId: RUN_ID,
      sessionId: SESSION_B,
      userId: USER_B,
      invocationId: "wrong-owner",
      leaseMs: 60_000,
    })).rejects.toThrow("subagent run access denied");
  });

  test("allows exactly one active invocation and preserves cumulative run usage", async () => {
    if (!pgAvailable) return;
    const claims = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      claimSubagentInvocation({
        runId: RUN_ID,
        sessionId: SESSION_A,
        userId: USER_A,
        invocationId: `invocation-${index}`,
        leaseMs: 60_000,
      })
    ));
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);

    const run = await getSubagentRun(RUN_ID);
    expect(run?.input_tokens).toBe(0);
    expect(run?.output_tokens).toBe(0);
  });

  test("does not create a queued run when immediate capacity is full", async () => {
    if (!pgAvailable) return;
    const created = await createSubagentRunIfCapacity({
      id: CAPACITY_RUN_ID,
      sessionId: SESSION_A,
      task: "capacity",
      maxActive: 1,
    });

    expect(created).toBe(false);
    expect(await getSubagentRun(CAPACITY_RUN_ID)).toBeNull();
  });

  test("atomically records two worker receipts plus fallback into ledger and daily totals", async () => {
    if (!pgAvailable) return;
    const runId = `subagent-complete-${suffix}`;
    const invocationId = `invocation-complete-${suffix}`;
    await createSubagentRun({ id: runId, sessionId: SESSION_A, task: "fallback accounting" });
    const claim = await claimSubagentInvocation({
      runId,
      sessionId: SESSION_A,
      userId: USER_A,
      invocationId,
      leaseMs: 60_000,
    });
    const [before] = await sql`
      SELECT input_tokens, output_tokens FROM user_daily_usage
      WHERE user_id = ${USER_A} AND usage_date = CURRENT_DATE`;
    await completeSubagentInvocation({
      sessionId: SESSION_A,
      userId: USER_A,
      runId,
      invocationId,
      ownerToken: claim.ownerToken!,
      generation: claim.generation!,
      status: "completed",
      summary: "fallback recovered",
      artifacts: [],
      usageEntries: [
        {
          usageKey: `subagent:${runId}:${invocationId}:1:sandbox_worker`,
          operationId: invocationId,
          attempt: 1,
          stage: "sandbox_worker",
          provider: "openai",
          model: "worker-model",
          inputTokens: 5,
          outputTokens: 2,
          status: "failed",
        },
        {
          usageKey: `subagent:${runId}:${invocationId}:2:sandbox_worker`,
          operationId: invocationId,
          attempt: 2,
          stage: "sandbox_worker",
          provider: "openai",
          model: "worker-model",
          inputTokens: 4,
          outputTokens: 1,
          status: "timed_out",
        },
        {
          usageKey: `subagent:${runId}:${invocationId}:3:fallback`,
          operationId: invocationId,
          attempt: 3,
          stage: "fallback",
          provider: "cloud-kernel",
          model: "fallback-model",
          inputTokens: 12,
          outputTokens: 6,
          status: "success",
        },
      ],
    });
    const ledger = await sql`
      SELECT stage, status, input_tokens, output_tokens FROM token_usage
      WHERE subagent_run_id = ${runId} ORDER BY attempt`;
    expect(ledger.map((row: Record<string, unknown>) => [row.stage, row.status])).toEqual([
      ["sandbox_worker", "failed"],
      ["sandbox_worker", "timed_out"],
      ["fallback", "success"],
    ]);
    expect(ledger.reduce(
      (sum: number, row: Record<string, unknown>) => sum + Number(row.input_tokens),
      0,
    )).toBe(21);
    expect(ledger.reduce(
      (sum: number, row: Record<string, unknown>) => sum + Number(row.output_tokens),
      0,
    )).toBe(9);
    const [after] = await sql`
      SELECT input_tokens, output_tokens FROM user_daily_usage
      WHERE user_id = ${USER_A} AND usage_date = CURRENT_DATE`;
    expect(Number(after.input_tokens) - Number(before?.input_tokens ?? 0)).toBe(21);
    expect(Number(after.output_tokens) - Number(before?.output_tokens ?? 0)).toBe(9);
  });
});
