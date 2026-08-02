import { computeNextRun } from "@piclaw-cloud/store";

/** Only explicit future schedules are persisted for scheduler execution. */
export function isDeferredSchedule(schedule: string | undefined): boolean {
  const normalized = schedule?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "now" && normalized !== "immediate";
}

export interface NormalizedAgentSchedule {
  type: "once" | "interval" | "cron";
  value: string;
  timezone: string | null;
  nextRun: string;
}

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseDuration(value: string): number | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = DURATION_UNITS_MS[match[2]!.toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || !unitMs) return null;
  return amount * unitMs;
}

export function normalizeAgentSchedule(
  schedule: string,
  options: { now?: Date; timezone?: string | null } = {},
): NormalizedAgentSchedule {
  const normalized = schedule.trim();
  const now = options.now ?? new Date();
  if (!normalized || Number.isNaN(now.getTime())) {
    throw new Error("unsupported schedule");
  }

  const relative = /^\+(.+)$/i.exec(normalized);
  if (relative) {
    const durationMs = parseDuration(relative[1] ?? "");
    if (!durationMs) throw new Error("unsupported schedule");
    const nextRun = new Date(now.getTime() + durationMs).toISOString();
    return { type: "once", value: nextRun, timezone: null, nextRun };
  }

  const interval = /^every\s+(.+)$/i.exec(normalized);
  if (interval) {
    const durationMs = parseDuration(interval[1] ?? "");
    if (!durationMs) throw new Error("unsupported schedule");
    const value = String(durationMs);
    const nextRun = computeNextRun("interval", value, { currentDate: now });
    if (!nextRun) throw new Error("unsupported schedule");
    return { type: "interval", value, timezone: null, nextRun };
  }

  const explicitInterval = /^interval:(\d+)$/i.exec(normalized);
  if (explicitInterval) {
    const value = explicitInterval[1]!;
    const nextRun = computeNextRun("interval", value, { currentDate: now });
    if (!nextRun) throw new Error("unsupported schedule");
    return { type: "interval", value, timezone: null, nextRun };
  }

  const cron = /^cron:?\s+(.+)$/i.exec(normalized)
    ?? (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+(?:\s+\S+)?$/.test(normalized)
      ? [normalized, normalized]
      : null);
  if (cron) {
    const timezone = options.timezone?.trim() || "";
    if (!timezone) throw new Error("timezone is required for cron schedules");
    const value = cron[1]!.trim();
    const nextRun = computeNextRun("cron", value, { currentDate: now, timezone });
    if (!nextRun) throw new Error("unsupported schedule");
    return { type: "cron", value, timezone, nextRun };
  }

  const once = /^once:\s*(.+)$/i.exec(normalized);
  if (once) {
    const value = once[1]!.trim();
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      throw new Error("once schedules require an ISO-8601 timestamp with Z or an explicit offset");
    }
    const nextRun = computeNextRun("once", value);
    if (!nextRun || new Date(nextRun).getTime() <= now.getTime()) {
      throw new Error("unsupported schedule");
    }
    return { type: "once", value: nextRun, timezone: options.timezone?.trim() || null, nextRun };
  }

  throw new Error("unsupported schedule");
}
