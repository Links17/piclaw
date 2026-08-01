import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import { claimDueScheduledTasks } from "./scheduler.ts";

const suffix = `scheduler-load-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const userId = `${suffix}-user`;
const sessionId = `${suffix}-session`;
const taskIds = Array.from({ length: 40 }, (_, index) => `${suffix}-task-${index}`);
let databaseAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'Scheduler load')`;
    await sql`INSERT INTO sessions (id, user_id, title) VALUES (${sessionId}, ${userId}, 'Scheduler load')`;
    for (const id of taskIds) {
      await sql`
        INSERT INTO scheduled_tasks (
          id, session_id, prompt, schedule_type, schedule_value, next_run, status
        ) VALUES (
          ${id}, ${sessionId}, 'load', 'once', ${new Date().toISOString()}, now(), 'active'
        )`;
    }
    databaseAvailable = true;
  } catch {
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
});

describe("scheduler multi-worker claim load", () => {
  test("claims every due task once across concurrent workers", async () => {
    if (!databaseAvailable) return;
    const batches = await Promise.all(
      Array.from({ length: 8 }, () => claimDueScheduledTasks(10, 60_000)),
    );
    const claimed = batches.flat().filter((task) => taskIds.includes(task.id));
    expect(claimed).toHaveLength(taskIds.length);
    expect(new Set(claimed.map((task) => task.id)).size).toBe(taskIds.length);
    expect(new Set(claimed.map((task) => task.claim_token)).size).toBe(taskIds.length);
  });
});
