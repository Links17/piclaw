import { describe, expect, test } from "bun:test";
import { isDeferredSchedule } from "./schedule.ts";

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
});
