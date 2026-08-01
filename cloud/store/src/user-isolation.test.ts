import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import {
  createSession,
  createSessionRecording,
  createSubagentRun,
  createMedia,
  deleteKeychainEntry,
  deleteUserSkill,
  deleteScheduledTaskForUser,
  deleteSession,
  getDailyTokenUsageBreakdown,
  getMediaByIdForUser,
  getScheduledTaskByIdForUser,
  getSessionRecordingMetaForUser,
  getSessionTokenUsageForUser,
  getSubagentRunForUser,
  insertMessage,
  listKeychainEntries,
  listMessagesForUser,
  listScheduledTasksForUser,
  listSessionRecordingsForUser,
  listSubagentRunsForUser,
  listUserSkills,
  logTokenUsage,
  revealKeychainSecret,
  setKeychainEntry,
  setSessionModelLabelForUser,
  setSessionThinkingLevelForUser,
  upsertUserSkill,
  upsertScheduledTask,
} from "./index.ts";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_A = `isolation-a-${suffix}`;
const USER_B = `isolation-b-${suffix}`;
const SESSION_A = `isolation-session-a-${suffix}`;
const SESSION_B = `isolation-session-b-${suffix}`;
const TASK_A = `isolation-task-a-${suffix}`;
const RUN_A = `isolation-run-a-${suffix}`;
const RECORDING_A = `isolation-recording-a-${suffix}`;
let pgAvailable = false;
let setupError: unknown;

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`
      INSERT INTO users (id, display_name)
      VALUES (${USER_A}, 'Isolation A'), (${USER_B}, 'Isolation B')`;
    await createSession(SESSION_A, "A", USER_A);
    await createSession(SESSION_B, "B", USER_B);
    pgAvailable = true;
  } catch (error) {
    setupError = error;
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await deleteSession(SESSION_A, USER_A).catch(() => undefined);
  await deleteSession(SESSION_B, USER_B).catch(() => undefined);
  await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
});

describe("explicit application ownership", () => {
  function requirePostgres(): void {
    if (!pgAvailable) throw new Error(`PostgreSQL unavailable: ${String(setupError)}`);
  }

  test("isolates messages and token usage under concurrent reads", async () => {
    requirePostgres();
    await insertMessage(SESSION_A, "user", "secret-a");
    await logTokenUsage({
      usageKey: `isolation:${SESSION_A}`,
      sessionId: SESSION_A,
      userId: USER_A,
      inputTokens: 7,
      outputTokens: 3,
    });

    const [ownedMessages, foreignMessages, ownedUsage, foreignUsage] = await Promise.all([
      listMessagesForUser(SESSION_A, USER_A),
      listMessagesForUser(SESSION_A, USER_B),
      getSessionTokenUsageForUser(SESSION_A, USER_A),
      getSessionTokenUsageForUser(SESSION_A, USER_B),
    ]);

    expect(ownedMessages.map((row) => row.content)).toContain("secret-a");
    expect(foreignMessages).toEqual([]);
    expect(ownedUsage?.totals.totalTokens).toBeGreaterThanOrEqual(10);
    expect(foreignUsage).toBeNull();
  });

  test("isolates scheduled tasks and rejects cross-user deletion", async () => {
    requirePostgres();
    await upsertScheduledTask({
      id: TASK_A,
      sessionId: SESSION_A,
      prompt: "private task",
      scheduleType: "interval",
      scheduleValue: "1h",
    });

    expect(await getScheduledTaskByIdForUser(TASK_A, USER_A)).not.toBeNull();
    expect(await getScheduledTaskByIdForUser(TASK_A, USER_B)).toBeNull();
    expect(await listScheduledTasksForUser({ userId: USER_B, sessionId: SESSION_A })).toEqual([]);
    expect(await deleteScheduledTaskForUser(TASK_A, USER_B)).toBe(false);
    expect(await getScheduledTaskByIdForUser(TASK_A, USER_A)).not.toBeNull();
  });

  test("isolates subagent runs and recordings", async () => {
    requirePostgres();
    await createSubagentRun({ id: RUN_A, sessionId: SESSION_A, task: "private run" });
    await createSessionRecording({
      id: RECORDING_A,
      chatJid: SESSION_A,
      title: "private recording",
      mode: "metadata",
      userId: USER_A,
    });

    expect(await getSubagentRunForUser(RUN_A, USER_A)).not.toBeNull();
    expect(await getSubagentRunForUser(RUN_A, USER_B)).toBeNull();
    expect(await listSubagentRunsForUser(SESSION_A, USER_B)).toEqual([]);
    expect(await getSessionRecordingMetaForUser(RECORDING_A, USER_A)).not.toBeNull();
    expect(await getSessionRecordingMetaForUser(RECORDING_A, USER_B)).toBeNull();
    expect(await listSessionRecordingsForUser(USER_B)).toEqual([]);
  });

  test("isolates media, skills, keychain, and daily quota data", async () => {
    requirePostgres();
    const mediaId = await createMedia({
      userId: USER_A,
      filename: "private.txt",
      contentType: "text/plain",
      objectKey: `test/${suffix}/private.txt`,
      objectSize: 7,
    });
    await upsertUserSkill({
      userId: USER_A,
      name: `private-skill-${suffix}`,
      description: "private",
      content: "secret skill",
    });
    await setKeychainEntry({
      name: `private-key-${suffix}`,
      type: "secret",
      secret: "key-secret",
    }, USER_A, "test-encryption-key");

    const [ownedMedia, foreignMedia, ownedSkills, foreignSkills, ownedKeys, foreignKeys, dailyA, dailyB] =
      await Promise.all([
        getMediaByIdForUser(mediaId, USER_A),
        getMediaByIdForUser(mediaId, USER_B),
        listUserSkills(USER_A),
        listUserSkills(USER_B),
        listKeychainEntries(USER_A),
        listKeychainEntries(USER_B),
        getDailyTokenUsageBreakdown(USER_A),
        getDailyTokenUsageBreakdown(USER_B),
      ]);

    expect(ownedMedia?.filename).toBe("private.txt");
    expect(foreignMedia).toBeNull();
    expect(ownedSkills.some((row) => row.name === `private-skill-${suffix}`)).toBe(true);
    expect(foreignSkills.some((row) => row.name === `private-skill-${suffix}`)).toBe(false);
    expect(ownedKeys.some((row) => row.name === `private-key-${suffix}`)).toBe(true);
    expect(foreignKeys.some((row) => row.name === `private-key-${suffix}`)).toBe(false);
    expect(await revealKeychainSecret(`private-key-${suffix}`, USER_B, "test-encryption-key")).toBeNull();
    expect(dailyA.totalTokens).toBeGreaterThanOrEqual(10);
    expect(dailyB.totalTokens).toBe(0);

    await deleteUserSkill(USER_A, `private-skill-${suffix}`);
    await deleteKeychainEntry(`private-key-${suffix}`, USER_A);
  });

  test("rejects cross-user session model preference updates", async () => {
    requirePostgres();
    expect(await setSessionModelLabelForUser(SESSION_A, USER_B, "provider/foreign")).toBe(false);
    expect(await setSessionThinkingLevelForUser(SESSION_A, USER_B, "high")).toBe(false);
    expect(await setSessionModelLabelForUser(SESSION_A, USER_A, "provider/owned")).toBe(true);
    expect(await setSessionThinkingLevelForUser(SESSION_A, USER_A, "low")).toBe(true);

    const rows = await sql`
      SELECT model_label, thinking_level FROM sessions WHERE id = ${SESSION_A}`;
    expect(rows[0]?.model_label).toBe("provider/owned");
    expect(rows[0]?.thinking_level).toBe("low");
  });
});
