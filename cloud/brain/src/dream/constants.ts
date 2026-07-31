export const DREAM_TASK_ID = "builtin-dream-midnight";
export const DREAM_TASK_KIND = "internal" as const;
export const DREAM_TASK_PROMPT = "dream";
export const DREAM_CRON = process.env.CLOUD_DREAM_CRON?.trim() || "0 0 * * *";
export const AUTO_DREAM_DEFAULT_DAYS = 2;
export const MANUAL_DREAM_DEFAULT_DAYS = 7;

export function parseDreamPromptToken(prompt: string): { matched: boolean; mode: "manual" | "auto"; days: number } {
  const trimmed = (prompt || "").trim().toLowerCase();
  const match = trimmed.match(/^(auto\s+dream|dream)(?:\s+(\d+))?$/i);
  if (!match) return { matched: false, mode: "manual", days: MANUAL_DREAM_DEFAULT_DAYS };
  const mode = match[1].toLowerCase().startsWith("auto") ? "auto" : "manual";
  const fallbackDays = mode === "auto" ? AUTO_DREAM_DEFAULT_DAYS : MANUAL_DREAM_DEFAULT_DAYS;
  const parsedDays = match[2] ? Number.parseInt(match[2], 10) : NaN;
  return {
    matched: true,
    mode,
    days: match[2]
      ? (Number.isFinite(parsedDays) ? Math.max(1, parsedDays) : fallbackDays)
      : fallbackDays,
  };
}
