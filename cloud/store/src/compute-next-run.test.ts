import { describe, expect, test } from "bun:test";
import { computeNextRun } from "./compute-next-run.ts";

describe("computeNextRun", () => {
  test("uses a valid UTC fallback when the local TZ is not an IANA timezone", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "GMT+0800";
    try {
      expect(computeNextRun("cron", "0 0 * * *")).not.toBeNull();
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  test("normalizes legacy POSIX offsets before serializing the timestamp", () => {
    expect(computeNextRun("cron", "0 0 * * *", { timezone: "GMT+0800" }))
      .toMatch(/Z$/);
  });
});
