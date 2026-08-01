import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import { getSessionForUser } from "./index.ts";

const suffix = `rls-strict-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const ownerId = `${suffix}-owner`;
const otherId = `${suffix}-other`;
const ownerSession = `${suffix}-session`;
const otherSession = `${suffix}-other-session`;
let databaseAvailable = false;
let setupError: unknown;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`
      INSERT INTO users (id, email, display_name)
      VALUES
        (${ownerId}, ${`${ownerId}@example.test`}, 'RLS owner'),
        (${otherId}, ${`${otherId}@example.test`}, 'RLS other')`;
    await sql`
      INSERT INTO sessions (id, user_id, title)
      VALUES
        (${ownerSession}, ${ownerId}, 'RLS owner session'),
        (${otherSession}, ${otherId}, 'RLS other session')`;
    databaseAvailable = true;
  } catch (error) {
    setupError = error;
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;
  await sql`DELETE FROM sessions WHERE id IN (${ownerSession}, ${otherSession})`;
  await sql`DELETE FROM users WHERE id IN (${ownerId}, ${otherId})`;
});

describe("application ownership with RLS disabled", () => {
  test("migration disables RLS while ownership helpers reject another user's session", async () => {
    if (!databaseAvailable) {
      throw new Error(`PostgreSQL unavailable: ${String(setupError)}`);
    }

    const tables = await sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('sessions', 'messages', 'scheduled_tasks', 'subagent_runs', 'token_usage')`;

    expect(tables.every((row: Record<string, unknown>) =>
      row.relrowsecurity === false && row.relforcerowsecurity === false
    )).toBe(true);
    expect(await getSessionForUser(ownerSession, ownerId)).not.toBeNull();
    expect(await getSessionForUser(otherSession, ownerId)).toBeNull();
  });
});
