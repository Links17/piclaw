import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, applyMigrations } from "./db.ts";
import {
  countActiveSandboxes,
  reserveTokenBudget,
  releaseTokenBudget,
  releaseSandboxQuotaReservation,
  reserveSandboxQuota,
  settleTokenBudget,
} from "./quota.ts";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_A = `quota-user-a-${suffix}`;
const USER_B = `quota-user-b-${suffix}`;
const SESSION_A1 = `quota-session-a1-${suffix}`;
const SESSION_A2 = `quota-session-a2-${suffix}`;
const SESSION_B1 = `quota-session-b1-${suffix}`;
let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`
      INSERT INTO users (id, display_name)
      VALUES (${USER_A}, 'Quota Test A'), (${USER_B}, 'Quota Test B')`;
    await sql`
      INSERT INTO sessions (id, user_id, title)
      VALUES
        (${SESSION_A1}, ${USER_A}, 'Quota A1'),
        (${SESSION_A2}, ${USER_A}, 'Quota A2'),
        (${SESSION_B1}, ${USER_B}, 'Quota B1')`;
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await sql`DELETE FROM sessions WHERE id IN (${SESSION_A1}, ${SESSION_A2}, ${SESSION_B1})`;
  await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
});

describe("sandbox quota reservations", () => {
  test("atomically reserves one active sandbox per user and releases capacity", async () => {
    if (!pgAvailable) {
      console.warn("Skipping sandbox quota reservation test: PostgreSQL unavailable");
      return;
    }

    const [first, second] = await Promise.all([
      reserveSandboxQuota(SESSION_A1, 1),
      reserveSandboxQuota(SESSION_A2, 1),
    ]);
    expect([first.reserved, second.reserved].filter(Boolean)).toHaveLength(1);
    expect(await countActiveSandboxes(USER_A)).toBe(1);

    const reservedSession = first.reserved ? SESSION_A1 : SESSION_A2;
    expect(await reserveSandboxQuota(reservedSession, 1)).toMatchObject({ reserved: false });

    const otherUser = await reserveSandboxQuota(SESSION_B1, 1);
    expect(otherUser.reserved).toBe(true);
    expect(await countActiveSandboxes(USER_B)).toBe(1);

    const blockedSession = first.reserved ? SESSION_A2 : SESSION_A1;
    await releaseSandboxQuotaReservation(reservedSession);
    expect(await countActiveSandboxes(USER_A)).toBe(0);
    expect(await reserveSandboxQuota(blockedSession, 1)).toMatchObject({ reserved: true });
  });
});

describe("daily token reservations", () => {
  test("serializes concurrent reservations and releases unused budget", async () => {
    if (!pgAvailable) return;
    const operationA = `quota-op-a-${suffix}`;
    const operationB = `quota-op-b-${suffix}`;

    const reservations = await Promise.all([
      reserveTokenBudget({
        userId: USER_A,
        operationId: operationA,
        estimatedTokens: 80,
        maxDailyTokens: 100,
        leaseMs: 60_000,
      }),
      reserveTokenBudget({
        userId: USER_A,
        operationId: operationB,
        estimatedTokens: 80,
        maxDailyTokens: 100,
        leaseMs: 60_000,
      }),
    ]);

    expect(reservations.filter((entry) => entry.reserved)).toHaveLength(1);
    const accepted = reservations.find((entry) => entry.reserved)!;
    await settleTokenBudget({
      reservationId: accepted.reservationId!,
      ownerToken: accepted.ownerToken!,
      generation: accepted.generation!,
      actualInputTokens: 10,
      actualOutputTokens: 5,
    });
    expect(await reserveTokenBudget({
      userId: USER_A,
      operationId: `${operationA}-next`,
      estimatedTokens: 80,
      maxDailyTokens: 100,
      leaseMs: 60_000,
    })).toMatchObject({ reserved: true });
  });

  test("reactivates a released operation with fencing and rejects the old owner", async () => {
    if (!pgAvailable) return;
    const operationId = `quota-fenced-${suffix}`;
    const first = await reserveTokenBudget({
      userId: USER_B,
      operationId,
      estimatedTokens: 20,
      maxDailyTokens: 100,
      leaseMs: 60_000,
    });
    expect(first).toMatchObject({ reserved: true, generation: 1 });
    expect(await releaseTokenBudget({
      reservationId: first.reservationId!,
      ownerToken: first.ownerToken!,
      generation: first.generation!,
    })).toBe(true);

    const second = await reserveTokenBudget({
      userId: USER_B,
      operationId,
      estimatedTokens: 20,
      maxDailyTokens: 100,
      leaseMs: 60_000,
    });
    expect(second).toMatchObject({
      reserved: true,
      reservationId: first.reservationId,
      generation: 2,
    });
    expect(await settleTokenBudget({
      reservationId: first.reservationId!,
      ownerToken: first.ownerToken!,
      generation: first.generation!,
      actualInputTokens: 2,
      actualOutputTokens: 1,
    })).toBe(false);
    expect(await settleTokenBudget({
      reservationId: second.reservationId!,
      ownerToken: second.ownerToken!,
      generation: second.generation!,
      actualInputTokens: 2,
      actualOutputTokens: 1,
    })).toBe(true);
  });

  test("does not disclose an active reservation owner to a concurrent replay", async () => {
    if (!pgAvailable) return;
    const operationId = `quota-owner-replay-${suffix}`;
    const first = await reserveTokenBudget({
      userId: USER_B,
      operationId,
      estimatedTokens: 10,
      maxDailyTokens: 100,
      leaseMs: 60_000,
    });
    const replay = await reserveTokenBudget({
      userId: USER_B,
      operationId,
      estimatedTokens: 10,
      maxDailyTokens: 100,
      leaseMs: 60_000,
    });
    expect(first).toMatchObject({ reserved: true, acquired: true });
    expect(replay).toMatchObject({
      reserved: true,
      acquired: false,
      reservationId: first.reservationId,
      generation: first.generation,
    });
    expect(replay.ownerToken).toBeUndefined();
  });
});
