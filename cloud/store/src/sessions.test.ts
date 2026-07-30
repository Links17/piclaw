import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { applyMigrations } from "./db.ts";
import {
  archiveSession,
  createSession,
  getSessionForUser,
  listSessions,
  purgeSession,
  renameSessionTitle,
  renameSessionTitleIfTemporary,
  restoreSession,
  UNTITLED_SESSION_TITLE,
} from "./index.ts";

const TEST_USER = "default-user";
const TEST_SESSION = `web:test-archive-${Date.now()}`;

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
  const row = await getSessionForUser(TEST_SESSION, TEST_USER);
  if (!row) return;
  if (!row.archived_at) {
    await archiveSession(TEST_SESSION, TEST_USER);
  }
  await purgeSession(TEST_SESSION, TEST_USER).catch(() => undefined);
});

describe("session archive lifecycle", () => {
  it("archives, hides from default list, restores, renames, and purges", async () => {
    if (!pgAvailable) {
      console.warn("Skipping session archive lifecycle test: PostgreSQL unavailable");
      return;
    }

    await createSession(TEST_SESSION, "Archive Test", TEST_USER);

    const archived = await archiveSession(TEST_SESSION, TEST_USER);
    expect(archived.archived_at).toBeTruthy();

    const activeOnly = await listSessions(TEST_USER);
    expect(activeOnly.some((row) => row.id === TEST_SESSION)).toBe(false);

    const withArchived = await listSessions(TEST_USER, { includeArchived: true });
    expect(withArchived.some((row) => row.id === TEST_SESSION)).toBe(true);

    const restored = await restoreSession(TEST_SESSION, TEST_USER);
    expect(restored.archived_at).toBeNull();

    const renamed = await renameSessionTitle(TEST_SESSION, "Renamed Chat", TEST_USER);
    expect(renamed.title).toBe("Renamed Chat");

    await createSession(`${TEST_SESSION}-temp`, UNTITLED_SESSION_TITLE, TEST_USER);
    const autoRenamed = await renameSessionTitleIfTemporary(`${TEST_SESSION}-temp`, "Generated title", TEST_USER);
    expect(autoRenamed?.title).toBe("Generated title");
    const manualKeep = await renameSessionTitle(`${TEST_SESSION}-temp`, "Manual title", TEST_USER);
    expect(manualKeep.title).toBe("Manual title");
    const blocked = await renameSessionTitleIfTemporary(`${TEST_SESSION}-temp`, "Should not apply", TEST_USER);
    expect(blocked).toBeNull();

    await archiveSession(`${TEST_SESSION}-temp`, TEST_USER);
    await purgeSession(`${TEST_SESSION}-temp`, TEST_USER);

    await archiveSession(TEST_SESSION, TEST_USER);
    const purged = await purgeSession(TEST_SESSION, TEST_USER);
    expect(purged.id).toBe(TEST_SESSION);

    const gone = await getSessionForUser(TEST_SESSION, TEST_USER);
    expect(gone).toBeNull();
  });

  it("rejects purge when session is not archived", async () => {
    if (!pgAvailable) return;

    const id = `${TEST_SESSION}-active`;
    await createSession(id, "Active", TEST_USER);
    await expect(purgeSession(id, TEST_USER)).rejects.toThrow("not archived");
    await archiveSession(id, TEST_USER);
    await purgeSession(id, TEST_USER);
  });
});
