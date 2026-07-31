import { CronExpressionParser } from "cron-parser";

export interface ComputeNextRunOptions {
  currentDate?: string | Date | null;
  timezone?: string | null;
}

/** Compute next run time for cron / interval / once schedules. */
export function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
  options: ComputeNextRunOptions = {},
): string | null {
  if (scheduleType === "cron") {
    try {
      const timezone = options.timezone || process.env.TZ || "UTC";
      const currentDate = options.currentDate ? new Date(options.currentDate) : undefined;
      return CronExpressionParser.parse(scheduleValue, {
        tz: timezone,
        ...(currentDate && !Number.isNaN(currentDate.getTime()) ? { currentDate } : {}),
      }).next().toISOString();
    } catch {
      return null;
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
