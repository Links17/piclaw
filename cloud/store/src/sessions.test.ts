import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { applyMigrations } from "./db.ts";
import {
  appendMessagesToSession,
  createForkedSession,
  createSession,
  deleteSession,
  getSessionForUser,
  hydrate,
  insertMessage,
  listMessages,
  listSessions,
  renameSessionTitle,
  renameSessionTitleIfTemporary,
  UNTITLED_SESSION_TITLE,
} from "./index.ts";
import { newCounter } from "./db.ts";

const TEST_USER = "default-user";
const TEST_SESSION = `web:test-session-${Date.now()}`;

let pgAvailable = false;

beforeAll(async () => {
  try {
    await applyMigrations();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await deleteSession(TEST_SESSION, TEST_USER).catch(() => undefined);
});

describe("session lifecycle", () => {
  it("lists, renames, and deletes sessions without archive state", async () => {
    if (!pgAvailable) {
      console.warn("Skipping session archive lifecycle test: PostgreSQL unavailable");
      return;
    }

    await createSession(TEST_SESSION, "Archive Test", TEST_USER);

    const sessions = await listSessions(TEST_USER);
    expect(sessions.some((row) => row.id === TEST_SESSION)).toBe(true);

    const renamed = await renameSessionTitle(TEST_SESSION, "Renamed Chat", TEST_USER);
    expect(renamed.title).toBe("Renamed Chat");

    await createSession(`${TEST_SESSION}-temp`, UNTITLED_SESSION_TITLE, TEST_USER);
    const autoRenamed = await renameSessionTitleIfTemporary(`${TEST_SESSION}-temp`, "Generated title", TEST_USER);
    expect(autoRenamed?.title).toBe("Generated title");
    const manualKeep = await renameSessionTitle(`${TEST_SESSION}-temp`, "Manual title", TEST_USER);
    expect(manualKeep.title).toBe("Manual title");
    const blocked = await renameSessionTitleIfTemporary(`${TEST_SESSION}-temp`, "Should not apply", TEST_USER);
    expect(blocked).toBeNull();

    await deleteSession(`${TEST_SESSION}-temp`, TEST_USER);

    const deleted = await deleteSession(TEST_SESSION, TEST_USER);
    expect(deleted.id).toBe(TEST_SESSION);

    const gone = await getSessionForUser(TEST_SESSION, TEST_USER);
    expect(gone).toBeNull();
  });

  it("copies fork history and appends merged branch messages", async () => {
    if (!pgAvailable) return;

    const parentId = `${TEST_SESSION}-lineage-parent`;
    const branchId = `${TEST_SESSION}-lineage-branch`;
    await createSession(parentId, "Parent", TEST_USER);
    await insertMessage(parentId, "user", "Parent prompt");
    await insertMessage(parentId, "assistant", "Parent reply");
    const inherited = await listMessages(parentId, 10);

    await createForkedSession(
      branchId,
      "Branch",
      TEST_USER,
      parentId,
      inherited.at(-1)?.id ?? null,
      inherited,
    );
    await insertMessage(branchId, "user", "Branch-only prompt");

    const branch = await getSessionForUser(branchId, TEST_USER);
    expect(branch?.parent_session_id).toBe(parentId);
    expect(branch?.inherited_message_count).toBe(2);
    expect((await listMessages(branchId, 10)).map((message) => message.content)).toEqual([
      "Parent prompt",
      "Parent reply",
      "Branch-only prompt",
    ]);

    await appendMessagesToSession(parentId, (await listMessages(branchId, 10)).slice(2));
    expect((await listMessages(parentId, 10)).map((message) => message.content)).toEqual([
      "Parent prompt",
      "Parent reply",
      "Branch-only prompt",
    ]);

    for (const id of [branchId, parentId]) await deleteSession(id, TEST_USER);
  });

  it("hydrates the complete bounded uncompacted interval beyond 500 rows", async () => {
    if (!pgAvailable) return;

    const sessionId = `${TEST_SESSION}-hydrate-bound`;
    await createSession(sessionId, "Hydrate Bound", TEST_USER);
    const ids: number[] = [];
    for (let index = 0; index < 620; index += 1) {
      ids.push(await insertMessage(
        sessionId,
        index % 2 === 0 ? "user" : "assistant",
        `message-${index + 1}`,
      ));
    }

    const rows = await hydrate(sessionId, newCounter(), {
      afterMessageId: ids[19],
      throughMessageId: ids[599],
    });

    expect(rows).toHaveLength(580);
    expect(rows[0]?.id).toBe(ids[20]);
    expect(rows.at(-1)?.id).toBe(ids[599]);

    await deleteSession(sessionId, TEST_USER);
  });
});
