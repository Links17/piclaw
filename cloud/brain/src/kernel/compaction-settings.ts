import * as store from "@piclaw-cloud/store";
import { DEFAULT_COMPACTION_SETTINGS } from "./pi.ts";

export type CompactionRuntimeSettings = typeof DEFAULT_COMPACTION_SETTINGS;

export async function getSessionCompactionSettings(
  userId: string,
  contextWindow: number,
): Promise<{ enabled: boolean; settings: CompactionRuntimeSettings }> {
  const snapshot = await store.getCompactionSettingsSnapshot(userId);
  const threshold = Number(snapshot.compactionThresholdPercent ?? 80);
  const normalizedThreshold = Number.isFinite(threshold)
    ? Math.min(95, Math.max(50, Math.round(threshold)))
    : 80;
  const reserveTokens = Math.max(
    1024,
    Math.round(contextWindow * (100 - normalizedThreshold) / 100),
  );

  return {
    enabled: snapshot.autoCompactionEnabled !== false,
    settings: {
      ...DEFAULT_COMPACTION_SETTINGS,
      enabled: snapshot.autoCompactionEnabled !== false,
      reserveTokens,
    },
  };
}
