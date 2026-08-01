import { describe, expect, test } from "bun:test";
import { isValidIsoTimestamp } from "./real-automation-e2e.ts";

describe("real automation E2E helpers", () => {
  test("accepts canonical ISO timestamps emitted by PostgreSQL", () => {
    expect(isValidIsoTimestamp("2026-08-01T00:42:00.000Z")).toBe(true);
    expect(isValidIsoTimestamp("2026-08-01 00:42:00+00")).toBe(true);
  });

  test("rejects missing or malformed scheduled next_run values", () => {
    expect(isValidIsoTimestamp(null)).toBe(false);
    expect(isValidIsoTimestamp("not-a-date")).toBe(false);
  });
});
