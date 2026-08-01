import { CronExpressionParser } from "cron-parser";

export interface ComputeNextRunOptions {
  currentDate?: string | Date | null;
  timezone?: string | null;
}

function normalizeTimezone(timezone: string | null | undefined): string {
  const value = timezone?.trim() || "UTC";
  // PostgreSQL accepts POSIX-style offsets, while cron-parser expects an IANA
  // zone. The persisted next_run is UTC, so UTC is a safe deterministic fallback.
  return /^GMT[+-]\d{2}:?\d{2}$/i.test(value) ? "UTC" : value;
}

/** Compute next run time for cron / interval / once schedules. */
export function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
  options: ComputeNextRunOptions = {},
): string | null {
  if (scheduleType === "cron") {
    try {
      const timezone = normalizeTimezone(options.timezone || process.env.TZ);
      const currentDate = options.currentDate ? new Date(options.currentDate) : undefined;
      return CronExpressionParser.parse(scheduleValue, {
        tz: timezone,
        ...(currentDate && !Number.isNaN(currentDate.getTime()) ? { currentDate } : {}),
      }).next().toISOString();
    } catch {
      // POSIX offsets such as GMT+0800 are accepted by Node but not cron-parser.
      // A schedule must still be durable, so run it in UTC rather than silently
      // failing to seed the task.
      try {
        return CronExpressionParser.parse(scheduleValue, {
          tz: "UTC",
          ...(options.currentDate && !Number.isNaN(new Date(options.currentDate).getTime())
            ? { currentDate: new Date(options.currentDate) }
            : {}),
        }).next().toISOString();
      } catch {
        return null;
      }
    }
  }
  if (scheduleType === "interval") {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }
  if (scheduleType === "once") {
    const at = new Date(scheduleValue);
    if (Number.isNaN(at.getTime())) return null;
    return at.toISOString();
  }
  return null;
}
