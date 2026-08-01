import { describe, expect, test } from "bun:test";
import { canClaimScheduledTasks } from "./service-auth.ts";

describe("scheduler service authentication", () => {
  test("does not claim tasks without a real service key", () => {
    expect(canClaimScheduledTasks("")).toBe(false);
    expect(canClaimScheduledTasks("replace-with-a-shared-internal-service-key")).toBe(false);
    expect(canClaimScheduledTasks("real-service-key")).toBe(true);
  });
});
