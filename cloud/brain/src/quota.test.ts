import { describe, expect, test } from "bun:test";
import { QuotaExceededError } from "./quota.ts";

describe("QuotaExceededError", () => {
  test("toJson returns structured quota_exceeded body", () => {
    const err = new QuotaExceededError("daily_tokens", 1000, 1000);
    expect(err.toJson()).toEqual({
      error: "quota_exceeded",
      code: "daily_tokens",
      limit: 1000,
      used: 1000,
      message: "daily token quota exceeded",
    });
  });
});
