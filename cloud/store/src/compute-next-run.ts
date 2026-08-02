import { CronExpressionParser } from "cron-parser";

export interface ComputeNextRunOptions {
  currentDate?: string | Date | null;
  timezone?: string | null;
}

function normalizeTimezone(timezone: string | null | undefined): string {
  const value = timezone?.trim() || "UTC";
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
      try {
        const currentDate = options.currentDate ? new Date(options.currentDate) : undefined;
        return CronExpressionParser.parse(scheduleValue, {
          tz: "UTC",
          ...(currentDate && !Number.isNaN(currentDate.getTime()) ? { currentDate } : {}),
        }).next().toISOString();
      } catch {
        return null;
      }
    }
  }
  if (scheduleType === "interval") {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) return null;
    const currentDate = options.currentDate ? new Date(options.currentDate) : new Date();
    if (Number.isNaN(currentDate.getTime())) return null;
    return new Date(currentDate.getTime() + ms).toISOString();
  }
  if (scheduleType === "once") {
    const at = new Date(scheduleValue);
    if (Number.isNaN(at.getTime())) return null;
    return at.toISOString();
  }
  return null;
}
