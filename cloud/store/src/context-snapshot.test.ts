import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations } from "./db.ts";
import { sql } from "./db.ts";
import {
  createSession,
  deleteSession,
  enqueueFollowup,
  getSessionContextSnapshotForUser,
  hydrateCommittedContext,
  insertMessage,
  upsertSessionContextSnapshot,
} from "./index.ts";

const USER_ID = "default-user";
const OTHER_USER_ID = `context-other-${Date.now()}`;
const SESSION_ID = `web:context-snapshot-${Date.now()}`;

let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    pgAvailable = true;
    await createSession(SESSION_ID, "Context snapshot", USER_ID);
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await deleteSession(SESSION_ID, USER_ID).catch(() => undefined);
});

describe("session context snapshots", () => {
  test("shares the durable snapshot across replicas with application ownership", async () => {
    if (!pgAvailable) return;

    const written = await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 12_345,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 41,
      latestMessageId: 44,
      compactedThroughMessageId: 0,
    });

    expect(written).toMatchObject({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 12_345,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 41,
      latestMessageId: 44,
      compactedThroughMessageId: 0,
    });

    // A second process/replica reads the database, not the writer's local Map.
    expect(await getSessionContextSnapshotForUser(SESSION_ID, USER_ID)).toMatchObject({
      usedTokens: 12_345,
      contextWindow: 128_000,
      throughMessageId: 41,
      latestMessageId: 44,
      compactedThroughMessageId: 0,
    });
    expect(await getSessionContextSnapshotForUser(SESSION_ID, OTHER_USER_ID)).toBeNull();
  });

  test("does not let an older turn boundary overwrite a newer snapshot", async () => {
    if (!pgAvailable) return;

    await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 20_000,
      contextWindow: 200_000,
      model: "anthropic/newer",
      provider: "anthropic",
      throughMessageId: 80,
      latestMessageId: 83,
      compactedThroughMessageId: 40,
    });
    const rejected = await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 99_999,
      contextWindow: 8_000,
      model: "openai/stale-recovery",
      provider: "openai",
      throughMessageId: 60,
      latestMessageId: 90,
      compactedThroughMessageId: 50,
    });

    expect(rejected).toBeNull();
    expect(await getSessionContextSnapshotForUser(SESSION_ID, USER_ID)).toMatchObject({
      usedTokens: 20_000,
      contextWindow: 200_000,
      model: "anthropic/newer",
      provider: "anthropic",
      throughMessageId: 80,
      latestMessageId: 83,
      compactedThroughMessageId: 40,
    });
  });

  test("allows compaction to lower occupancy at the same boundary", async () => {
    if (!pgAvailable) return;

    await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 70_000,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 100,
      latestMessageId: 103,
      compactedThroughMessageId: 60,
    });
    await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 18_000,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 100,
      latestMessageId: 103,
      compactedThroughMessageId: 80,
    });

    expect(await getSessionContextSnapshotForUser(SESSION_ID, USER_ID)).toMatchObject({
      usedTokens: 18_000,
      throughMessageId: 100,
      latestMessageId: 103,
      compactedThroughMessageId: 80,
    });
  });

  test("rejects an older compaction checkpoint at the same message boundary", async () => {
    if (!pgAvailable) return;

    await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 12_000,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 120,
      latestMessageId: 124,
      compactedThroughMessageId: 100,
    });
    const rejected = await upsertSessionContextSnapshot({
      sessionId: SESSION_ID,
      userId: USER_ID,
      usedTokens: 70_000,
      contextWindow: 128_000,
      model: "openai/gpt-context",
      provider: "openai",
      throughMessageId: 120,
      latestMessageId: 130,
      compactedThroughMessageId: 90,
    });

    expect(rejected).toBeNull();
    expect(await getSessionContextSnapshotForUser(SESSION_ID, USER_ID)).toMatchObject({
      usedTokens: 12_000,
      compactedThroughMessageId: 100,
    });
  });
});

describe("committed history boundary", () => {
  test("includes persisted assistant/tool rounds and excludes queued future users", async () => {
    if (!pgAvailable) return;
    const sessionId = `${SESSION_ID}-history-boundary`;
    await createSession(sessionId, "Committed history", USER_ID);
    const activeUser = await insertMessage(sessionId, "user", "active request");
    const queuedUser = await insertMessage(sessionId, "user", "queued future request");
    await insertMessage(sessionId, "assistant", "tool call", {
      contentBlocks: { user_message_id: activeUser, turn_operation_id: `turn:${sessionId}:${activeUser}` },
    });
    await insertMessage(sessionId, "tool", "tool result", {
      contentBlocks: { user_message_id: activeUser, turn_operation_id: `turn:${sessionId}:${activeUser}` },
    });
    const finalAssistant = await insertMessage(sessionId, "assistant", "final answer", {
      contentBlocks: { user_message_id: activeUser, turn_operation_id: `turn:${sessionId}:${activeUser}` },
    });
    await insertMessage(sessionId, "assistant", "queued answer", {
      contentBlocks: { user_message_id: queuedUser, turn_operation_id: `turn:${sessionId}:${queuedUser}` },
    });

    await sql`
      UPDATE session_cursors
      SET cursor_message_id = ${activeUser}, queued_followups = '[]'::jsonb
      WHERE session_id = ${sessionId}`;
    await enqueueFollowup(sessionId, {
      content: "queued future request",
      messageId: queuedUser,
    });

    expect((await hydrateCommittedContext(sessionId, { count: 0 }, {
      activeUserMessageId: activeUser,
    })).map((row) => row.id)).toEqual([
      activeUser,
      finalAssistant - 2,
      finalAssistant - 1,
      finalAssistant,
    ]);

    await sql`
      UPDATE session_cursors
      SET cursor_message_id = ${queuedUser}, queued_followups = '[]'::jsonb
      WHERE session_id = ${sessionId}`;
    expect((await hydrateCommittedContext(sessionId, { count: 0 }, {
      activeUserMessageId: queuedUser,
    })).map((row) => row.id)).toEqual([
      activeUser,
      queuedUser,
      finalAssistant - 2,
      finalAssistant - 1,
      finalAssistant,
      finalAssistant + 1,
    ]);

    await deleteSession(sessionId, USER_ID);
  });
});
