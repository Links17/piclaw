import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { sql } from "./db.ts";
import type { UserPreferences } from "./model-preferences.ts";
import { getUserPreferences, updateUserPreferences } from "./model-preferences.ts";

export interface GeneralSettingsSnapshot {
  assistantName: string;
  assistantAvatar: string;
  userName: string;
  userAvatar: string;
  userAvatarBackground: string;
  sessionAutoRotate: boolean;
  sessionMaxSizeMb: number;
  sessionMaxLines: number;
  webTerminalEnabled: boolean;
  composeUploadLimitMb: number;
  workspaceUploadLimitMb: number;
  toolUseBudget: number;
  toolOutputStoreThreshold: number;
  sessionMaxCompactions: number;
  sessionIsolation: "none" | "summary" | "full";
  searchMatchMode: "or" | "and";
  scopedModelsOnly: boolean;
  automaticRecoveryEnabled: boolean;
  automaticRecoveryMaxAttempts: number;
  automaticRecoveryTotalBudgetMs: number;
  uiTheme: string;
  uiTint: string | null;
  outputPad: number;
  widgetToken: string;
}

export interface CompactionSettingsSnapshot {
  autoCompactionEnabled: boolean;
  smartCompactionMethod: "selective" | "pipelined";
  remoteCompactionEnabled: boolean;
  remoteCompactionTimeoutSec: number;
  remoteCompactionSupportedProviders: string[];
  compactionTimeoutSec: number;
  compactionBackoffBaseMin: number;
  compactionBackoffMaxMin: number;
  compactionThresholdPercent: number;
  compactionBackoffDecayFactor: number;
  progressWatchdogEnabled: boolean;
  progressWatchdogTimeoutSec: number;
  toolResultCompactionEnabled: boolean;
  toolResultCompactionTools: string[];
  toolResultSemanticSummaryEnabled: boolean;
  toolResultSemanticSummaryMaxInputChars: number;
  toolResultSemanticSummaryMaxTokens: number;
  toolResultSemanticSummaryTimeoutSec: number;
  compactionBackoffs: unknown[];
  progressWatchdogPhases: unknown[];
}

export type StoredUserSettings = Partial<GeneralSettingsSnapshot & CompactionSettingsSnapshot & UserPreferences>;

function defaultGeneralSettings(): GeneralSettingsSnapshot {
  return {
    assistantName: "Assistant",
    assistantAvatar: "",
    userName: "User",
    userAvatar: "",
    userAvatarBackground: "",
    sessionAutoRotate: true,
    sessionMaxSizeMb: 16,
    sessionMaxLines: 4000,
    webTerminalEnabled: true,
    composeUploadLimitMb: 32,
    workspaceUploadLimitMb: 256,
    toolUseBudget: 64,
    toolOutputStoreThreshold: 8192,
    sessionMaxCompactions: 3,
    sessionIsolation: "none",
    searchMatchMode: "or",
    scopedModelsOnly: false,
    automaticRecoveryEnabled: true,
    automaticRecoveryMaxAttempts: 0,
    automaticRecoveryTotalBudgetMs: 360_000,
    uiTheme: "default",
    uiTint: null,
    outputPad: 0,
    widgetToken: "",
  };
}

function defaultCompactionSettings(): CompactionSettingsSnapshot {
  return {
    autoCompactionEnabled: true,
    smartCompactionMethod: "selective",
    remoteCompactionEnabled: false,
    remoteCompactionTimeoutSec: 300,
    remoteCompactionSupportedProviders: ["openai", "openai-codex"],
    compactionTimeoutSec: 300,
    compactionBackoffBaseMin: 15,
    compactionBackoffMaxMin: 360,
    compactionThresholdPercent: 80,
    compactionBackoffDecayFactor: 0.5,
    progressWatchdogEnabled: false,
    progressWatchdogTimeoutSec: 120,
    toolResultCompactionEnabled: true,
    toolResultCompactionTools: [],
    toolResultSemanticSummaryEnabled: false,
    toolResultSemanticSummaryMaxInputChars: 24_000,
    toolResultSemanticSummaryMaxTokens: 1024,
    toolResultSemanticSummaryTimeoutSec: 45,
    compactionBackoffs: [],
    progressWatchdogPhases: [],
  };
}

async function readStoredSettings(userId: string): Promise<StoredUserSettings> {
  const rows = await sql`SELECT preferences FROM users WHERE id = ${userId}`;
  const raw = rows[0]?.preferences;
  return raw && typeof raw === "object" ? raw as StoredUserSettings : {};
}

export async function getGeneralSettingsSnapshot(userId = DEFAULT_USER_ID): Promise<GeneralSettingsSnapshot> {
  const prefs = await readStoredSettings(userId);
  const defaults = defaultGeneralSettings();
  return {
    ...defaults,
    ...prefs,
    searchMatchMode: prefs.searchMatchMode === "and" ? "and" : "or",
    scopedModelsOnly: Boolean(prefs.scopedModelsOnly),
    uiTint: typeof prefs.uiTint === "string" ? prefs.uiTint : defaults.uiTint,
  };
}

export async function getCompactionSettingsSnapshot(userId = DEFAULT_USER_ID): Promise<CompactionSettingsSnapshot> {
  const prefs = await readStoredSettings(userId);
  return { ...defaultCompactionSettings(), ...prefs };
}

export async function saveGeneralSettingsPatch(
  patch: Partial<GeneralSettingsSnapshot>,
  userId = DEFAULT_USER_ID,
): Promise<GeneralSettingsSnapshot> {
  const current = await readStoredSettings(userId);
  const next = { ...current, ...patch };
  await sql`
    UPDATE users SET preferences = ${JSON.stringify(next)}::jsonb
    WHERE id = ${userId}`;
  return getGeneralSettingsSnapshot(userId);
}

export async function saveCompactionSettingsPatch(
  patch: Partial<CompactionSettingsSnapshot>,
  userId = DEFAULT_USER_ID,
): Promise<CompactionSettingsSnapshot> {
  const current = await readStoredSettings(userId);
  const next = { ...current, ...patch };
  await sql`
    UPDATE users SET preferences = ${JSON.stringify(next)}::jsonb
    WHERE id = ${userId}`;
  return getCompactionSettingsSnapshot(userId);
}

export async function ensureWidgetToken(userId = DEFAULT_USER_ID): Promise<string> {
  const general = await getGeneralSettingsSnapshot(userId);
  if (general.widgetToken.trim()) return general.widgetToken;
  const token = `piclaw_${crypto.randomUUID().replace(/-/g, "")}`;
  await saveGeneralSettingsPatch({ widgetToken: token }, userId);
  return token;
}

export { getUserPreferences, updateUserPreferences };
