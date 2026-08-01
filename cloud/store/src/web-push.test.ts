import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, sql } from "./db.ts";
import {
  listWebPushSubscriptions,
  removeWebPushSubscription,
  upsertWebPushSubscription,
} from "./web-push.ts";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_A = `push-user-a-${suffix}`;
const USER_B = `push-user-b-${suffix}`;
const endpoint = `https://push.example.test/${suffix}`;
let pgAvailable = false;

const subscription = {
  endpoint,
  expirationTime: null,
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

beforeAll(async () => {
  try {
    await applyMigrations();
    await sql`
      INSERT INTO users (id, display_name)
      VALUES (${USER_A}, 'Push A'), (${USER_B}, 'Push B')`;
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
});

describe("web push ownership", () => {
  test("requires user ownership on list, registration and deletion", async () => {
    if (!pgAvailable) return;
    await expect(upsertWebPushSubscription(subscription, {} as never)).rejects.toThrow("userId");
    await expect(listWebPushSubscriptions(undefined as never)).rejects.toThrow("userId");
    await expect(removeWebPushSubscription(endpoint, undefined as never)).rejects.toThrow("userId");
  });

  test("does not transfer an endpoint between users and isolates deletion", async () => {
    if (!pgAvailable) return;
    await upsertWebPushSubscription(subscription, { userId: USER_A });
    await expect(
      upsertWebPushSubscription(
        { ...subscription, keys: { p256dh: "foreign-key", auth: "foreign-auth" } },
        { userId: USER_B },
      ),
    ).rejects.toThrow("owned by another user");

    expect(await listWebPushSubscriptions(USER_A)).toHaveLength(1);
    expect(await listWebPushSubscriptions(USER_B)).toEqual([]);
    expect(await removeWebPushSubscription(endpoint, USER_B)).toBe(false);
    expect(await listWebPushSubscriptions(USER_A)).toHaveLength(1);
    expect(await removeWebPushSubscription(endpoint, USER_A)).toBe(true);
  });
});
