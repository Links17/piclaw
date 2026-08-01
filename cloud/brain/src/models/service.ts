import * as store from "@piclaw-cloud/store";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { config } from "../config.ts";
import {
  buildProviderRegistryEntries,
  type ProviderModelConfig,
} from "../kernel/provider-registry.ts";

export interface AvailableModelOption {
  label: string;
  provider: string;
  id: string;
  name: string | null;
  context_window: number | null;
  reasoning: boolean;
  thinking_levels: string[];
  thinking_level_labels: string[];
}

export interface AvailableModelsResult {
  current: string | null;
  models: string[];
  model_options: AvailableModelOption[];
  thinking_level: string | null;
  thinking_level_label: string | null;
  supports_thinking: boolean;
  available_thinking_levels: string[];
  available_thinking_level_labels: string[];
  provider_usage: null;
  latest_requested_model: string | null;
  latest_response_model: string | null;
  scoped_models_only: boolean;
  enabled_model_patterns: string[];
  provider_diagnostics: { providers: unknown[] };
  oobe?: { provider_ready_completed_instance: boolean };
}

const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

function chatJidToSessionId(chatJid: string | null | undefined): string {
  return typeof chatJid === "string" ? chatJid.trim() : "";
}

function modelLabel(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function buildModelOption(model: {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}): AvailableModelOption {
  const label = modelLabel(model.provider, model.id);
  const thinkingLevels = model.reasoning ? DEFAULT_THINKING_LEVELS : ["off"];
  return {
    label,
    provider: model.provider,
    id: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : null,
    context_window: typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : null,
    reasoning: Boolean(model.reasoning),
    thinking_levels: thinkingLevels,
    thinking_level_labels: thinkingLevels,
  };
}

function configuredModelOptions(): AvailableModelOption[] {
  return buildProviderRegistryEntries({
    openai: {
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
    },
    providers: config.providers,
  }).flatMap((provider) => provider.models.map((model: ProviderModelConfig) =>
    buildModelOption({
      provider: provider.id,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    }),
  ));
}

export async function getAvailableModels(chatJid: string, userId = DEFAULT_USER_ID): Promise<AvailableModelsResult> {
  const sessionId = chatJidToSessionId(chatJid);
  const ownedSession = sessionId ? await store.getSessionForUser(sessionId, userId) : null;
  const prefs = ownedSession
    ? await store.getSessionModelPrefs(sessionId)
    : { modelLabel: null, thinkingLevel: null };
  const userPrefs = await store.getUserPreferences(userId);
  const modelOptions = configuredModelOptions();
  const configuredProviders = buildProviderRegistryEntries({
    openai: {
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
    },
    providers: config.providers,
  });
  const models = modelOptions.map((option) => option.label);
  const defaultModel = modelOptions[0] ?? null;
  const currentModel = prefs.modelLabel || defaultModel?.label || null;
  const currentModelOption = modelOptions.find((option) => option.label === currentModel) ?? modelOptions[0];
  if (!currentModelOption) {
    throw new Error("No cloud provider models are configured");
  }
  const thinkingLevel = prefs.thinkingLevel ?? "off";
  const supportsThinking = Boolean(currentModelOption.reasoning);
  const availableThinkingLevels = supportsThinking
    ? currentModelOption.thinking_levels
    : ["off"];

  return {
    current: currentModel,
    models,
    model_options: modelOptions,
    thinking_level: thinkingLevel,
    thinking_level_label: thinkingLevel,
    supports_thinking: supportsThinking,
    available_thinking_levels: availableThinkingLevels,
    available_thinking_level_labels: availableThinkingLevels,
    provider_usage: null,
    latest_requested_model: currentModel,
    latest_response_model: currentModel,
    scoped_models_only: Boolean(userPrefs.scopedModelsOnly),
    enabled_model_patterns: [],
    provider_diagnostics: {
      providers: configuredProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: Boolean(provider.baseUrl.trim() && provider.apiKey.trim()),
        model_count: provider.models.length,
      })),
    },
    oobe: { provider_ready_completed_instance: modelOptions.length > 0 },
  };
}

export async function switchSessionModel(
  chatJid: string,
  label: string,
  userId: string,
): Promise<{ ok: boolean; message?: string }> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) return { ok: false, message: "chat_jid is required" };
  const available = await getAvailableModels(chatJid, userId);
  const match = available.model_options.find((option) => option.label === label.trim())
    ?? available.model_options.find((option) => option.id === label.trim());
  if (!match) return { ok: false, message: `Unknown model: ${label}` };
  if (!(await store.setSessionModelLabelForUser(sessionId, userId, match.label))) {
    return { ok: false, message: "session access denied" };
  }
  return { ok: true, message: `Model switched to ${match.label}` };
}

export async function switchSessionThinkingLevel(
  chatJid: string,
  level: string,
  userId: string,
): Promise<{ ok: boolean; message?: string }> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) return { ok: false, message: "chat_jid is required" };
  const available = await getAvailableModels(chatJid, userId);
  const normalized = level.trim().toLowerCase();
  if (!available.available_thinking_levels.includes(normalized)) {
    return { ok: false, message: `Unsupported thinking level: ${level}` };
  }
  if (!(await store.setSessionThinkingLevelForUser(sessionId, userId, normalized))) {
    return { ok: false, message: "session access denied" };
  }
  return { ok: true, message: `Thinking level set to ${normalized}` };
}

export function parseModelSlashCommand(content: string): { type: "model"; target?: string } | { type: "thinking"; target?: string } | null {
  const trimmed = content.trim();
  if (trimmed === "/model") return { type: "model" };
  if (trimmed.startsWith("/model ")) return { type: "model", target: trimmed.slice(7).trim() };
  if (trimmed === "/thinking") return { type: "thinking" };
  if (trimmed.startsWith("/thinking ")) return { type: "thinking", target: trimmed.slice(10).trim() };
  return null;
}

export async function handleModelSlashCommand(
  chatJid: string,
  content: string,
  userId = DEFAULT_USER_ID,
): Promise<{ uiOnly: true; command: Record<string, unknown> } | null> {
  const parsed = parseModelSlashCommand(content);
  if (!parsed) return null;
  const available = await getAvailableModels(chatJid, userId);

  if (parsed.type === "model" && !parsed.target) {
    const lines = available.models.length
      ? available.models.map((label) => `- ${label}${label === available.current ? " (current)" : ""}`).join("\n")
      : "No models available.";
    return {
      uiOnly: true,
      command: {
        status: "success",
        message: lines,
        model_label: available.current,
        thinking_level: available.thinking_level,
        thinking_level_label: available.thinking_level_label,
        supports_thinking: available.supports_thinking,
      },
    };
  }

  if (parsed.type === "model" && parsed.target) {
    const result = await switchSessionModel(chatJid, parsed.target, userId);
    const next = await getAvailableModels(chatJid, userId);
    return {
      uiOnly: true,
      command: {
        status: result.ok ? "success" : "error",
        message: result.message,
        model_label: next.current,
        thinking_level: next.thinking_level,
        thinking_level_label: next.thinking_level_label,
        supports_thinking: next.supports_thinking,
      },
    };
  }

  if (parsed.type === "thinking" && !parsed.target) {
    return {
      uiOnly: true,
      command: {
        status: "success",
        message: `Thinking level: ${available.thinking_level_label || available.thinking_level || "off"}`,
        model_label: available.current,
        thinking_level: available.thinking_level,
        thinking_level_label: available.thinking_level_label,
        supports_thinking: available.supports_thinking,
      },
    };
  }

  if (parsed.type === "thinking" && parsed.target) {
    const result = await switchSessionThinkingLevel(chatJid, parsed.target, userId);
    const next = await getAvailableModels(chatJid, userId);
    return {
      uiOnly: true,
      command: {
        status: result.ok ? "success" : "error",
        message: result.message,
        model_label: next.current,
        thinking_level: next.thinking_level,
        thinking_level_label: next.thinking_level_label,
        supports_thinking: next.supports_thinking,
      },
    };
  }

  return null;
}
