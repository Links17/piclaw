/** Only explicit future schedules are persisted for scheduler execution. */
export function isDeferredSchedule(schedule: string | undefined): boolean {
  const normalized = schedule?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "now" && normalized !== "immediate";
}
