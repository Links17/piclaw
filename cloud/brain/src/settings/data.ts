import * as store from "@piclaw-cloud/store";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { config } from "../config.ts";
import { CLOUD_KERNEL_PROVIDER_ID } from "../kernel/provider.ts";
import { getKernelRuntime } from "../kernel/runtime.ts";
import { CORE_TOOL_DEFINITIONS } from "../tools/schemas.ts";

const THEME_COLOR_KEYS = [
  "bg", "surface", "surface2", "border", "text", "textMuted", "accent", "accentText",
  "danger", "success", "warning", "userBubble", "agentBubble", "toolBubble",
];

function buildToolsets() {
  return [{
    name: "cloud-core",
    description: "PiClaw cloud kernel tools",
    tools: CORE_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.function.name,
      kind: "tool",
      weight: 1,
      summary: tool.function.description,
    })),
  }];
}

function buildProviders() {
  const kernel = getKernelRuntime();
  const providerId = kernel?.providerId ?? CLOUD_KERNEL_PROVIDER_ID;
  return [{
    id: providerId,
    label: "PiClaw Cloud",
    configured: Boolean(kernel),
    authType: kernel ? "api_key" : null,
    isCustom: false,
  }];
}

function buildThemes() {
  return [{
    name: "default",
    label: "Default",
    mode: "dark",
    colors: {},
  }];
}

export async function getSettingsData(userId = DEFAULT_USER_ID) {
  const [general, compaction, widgetToken] = await Promise.all([
    store.getGeneralSettingsSnapshot(userId),
    store.getCompactionSettingsSnapshot(userId),
    store.ensureWidgetToken(userId),
  ]);

  return {
    ...general,
    widgetToken,
    ...compaction,
    version: "cloud",
    runtimePlatform: process.platform,
    quickActions: [],
    workspaceSettings: {
      refreshIntervalSec: 60,
      folderPreviewDepth: 3,
    },
    environmentSettings: {
      variables: [],
      overrides: {},
      count: 0,
      overrideCount: 0,
      keychainEnvNames: [],
    },
    providers: buildProviders(),
    themes: buildThemes(),
    colorKeys: THEME_COLOR_KEYS,
    toolsets: buildToolsets(),
    instanceTotp: {
      configured: false,
      issuer: "",
      label: "",
      secret: "",
      otpauth: "",
      qrSvg: "",
    },
    openaiModel: config.openaiModel,
  };
}
