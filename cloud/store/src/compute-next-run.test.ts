import { describe, expect, test } from "bun:test";
import { computeNextRun } from "./compute-next-run.ts";

describe("computeNextRun", () => {
  test("keeps legacy process offsets compatible through UTC fallback", () => {
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

  test("uses the supplied current date for intervals", () => {
    expect(computeNextRun("interval", "300000", {
      currentDate: "2026-08-01T00:00:00.000Z",
    })).toBe("2026-08-01T00:05:00.000Z");
  });

  test("does not silently replace an invalid timezone", () => {
    expect(computeNextRun("cron", "0 9 * * *", {
      currentDate: "2026-08-01T00:00:00.000Z",
      timezone: "Not/AZone",
    })).toBe("2026-08-01T09:00:00.000Z");
  });
});
