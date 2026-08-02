import { describe, expect, test } from "bun:test";
import { isDeferredSchedule, normalizeAgentSchedule } from "./schedule.ts";

describe("subagent scheduling", () => {
  test("executes now and immediate requests instead of deferring them", () => {
    expect(isDeferredSchedule(undefined)).toBe(false);
    expect(isDeferredSchedule("")).toBe(false);
    expect(isDeferredSchedule("now")).toBe(false);
    expect(isDeferredSchedule(" immediate ")).toBe(false);
  });

  test("keeps actual future schedules deferred", () => {
    expect(isDeferredSchedule("cron 0 * * * *")).toBe(true);
    expect(isDeferredSchedule("every 5m")).toBe(true);
  });

  test("normalizes relative once schedules", () => {
    expect(normalizeAgentSchedule("+10m", {
      now: new Date("2026-08-01T00:00:00.000Z"),
    })).toEqual({
      type: "once",
      value: "2026-08-01T00:10:00.000Z",
      timezone: null,
      nextRun: "2026-08-01T00:10:00.000Z",
    });
  });

  test("normalizes interval and cron schedules", () => {
    expect(normalizeAgentSchedule("every 5m", {
      now: new Date("2026-08-01T00:00:00.000Z"),
    })).toEqual({
      type: "interval",
      value: "300000",
      timezone: null,
      nextRun: "2026-08-01T00:05:00.000Z",
    });
    expect(normalizeAgentSchedule("cron 0 9 * * *", {
      now: new Date("2026-08-01T00:00:00.000Z"),
      timezone: "Asia/Shanghai",
    })).toEqual({
      type: "cron",
      value: "0 9 * * *",
      timezone: "Asia/Shanghai",
      nextRun: "2026-08-01T01:00:00.000Z",
    });
    expect(normalizeAgentSchedule("0 10 * * *", {
      now: new Date("2026-08-01T00:00:00.000Z"),
      timezone: "Asia/Shanghai",
    })).toMatchObject({
      type: "cron",
      value: "0 10 * * *",
      timezone: "Asia/Shanghai",
    });
  });

  test("rejects invalid and timezone-less cron schedules", () => {
    expect(() => normalizeAgentSchedule("cron 0 9 * * *", {
      now: new Date("2026-08-01T00:00:00.000Z"),
    })).toThrow("timezone is required");
    expect(() => normalizeAgentSchedule("sometime tomorrow")).toThrow("unsupported schedule");
    expect(() => normalizeAgentSchedule("once: 2026-08-02 09:00", {
      timezone: "Asia/Shanghai",
    })).toThrow("explicit offset");
  });
});
