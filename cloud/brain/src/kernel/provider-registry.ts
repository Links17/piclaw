import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { CloudConfig } from "@piclaw-cloud/shared/cloud-config";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ProviderRegistryEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelConfig[];
}

export interface ResolvedProviderModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ProviderModelRuntime {
  models: MutableModels;
  model: Model<"openai-completions">;
  apiKey: string;
}

export type ProviderSecretReader = (name: string, userId: string) => Promise<string | null>;

export const providerApiKeySecretName = (providerId: string) => `provider:${providerId}:api_key`;
export const providerBaseUrlSecretName = (providerId: string) => `provider:${providerId}:base_url`;

export function buildProviderRegistryEntries(
  cloud: Pick<CloudConfig, "openai" | "providers">,
): ProviderRegistryEntry[] {
  const legacy: ProviderRegistryEntry = {
    id: "piclaw-cloud",
    name: "PiClaw Cloud",
    baseUrl: cloud.openai.baseUrl,
    apiKey: cloud.openai.apiKey,
    models: [{
      id: cloud.openai.model,
      name: cloud.openai.model,
    }],
  };
  const additional = (cloud.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name?.trim() || provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: provider.models,
  }));
  return [legacy, ...additional];
}

export function createKeychainSecretReader(
  encryptionKey: string,
): ProviderSecretReader {
  return async (name, userId) => {
    const store = await import("@piclaw-cloud/store");
    return store.revealKeychainSecret(name, userId, encryptionKey);
  };
}

export function parseProviderModelLabel(
  label: string | null | undefined,
): { provider: string; model: string } | null {
  const text = typeof label === "string" ? label.trim() : "";
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return null;

  const provider = text.slice(0, slash).trim();
  const model = text.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}

function defaultProvider(providers: ProviderRegistryEntry[]): ProviderRegistryEntry {
  const provider = providers[0];
  if (!provider) throw new Error("No cloud providers are configured");
  return provider;
}

function resolveModel(
  provider: ProviderRegistryEntry,
  selectedModel: string | null,
): ProviderModelConfig {
  const model = selectedModel
    ? provider.models.find((candidate) => candidate.id === selectedModel)
    : provider.models[0];
  if (!model) {
    throw new Error(
      selectedModel
        ? `Unknown model "${selectedModel}" for provider "${provider.id}"`
        : `Provider "${provider.id}" has no configured models`,
    );
  }
  return model;
}

export function resolveProviderModel(
  providers: ProviderRegistryEntry[],
  label: string | null | undefined,
): ResolvedProviderModel {
  const parsed = parseProviderModelLabel(label);
  const fallback = defaultProvider(providers);
  const provider = parsed
    ? providers.find((candidate) => candidate.id === parsed.provider)
    : fallback;
  if (!provider) throw new Error(`Unknown provider "${parsed!.provider}"`);

  const apiKey = provider.apiKey.trim();
  const baseUrl = provider.baseUrl.trim().replace(/\/$/, "");
  if (!baseUrl || !apiKey) {
    throw new Error(`Provider "${provider.id}" is missing endpoint or credentials`);
  }

  const model = resolveModel(provider, parsed?.model ?? null);
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name?.trim() || model.id,
    baseUrl,
    apiKey,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8192,
    reasoning: Boolean(model.reasoning),
  };
}

export async function resolveProviderModelForUser(
  providers: ProviderRegistryEntry[],
  label: string | null | undefined,
  userId: string,
  readSecret: ProviderSecretReader,
): Promise<ResolvedProviderModel> {
  const parsed = parseProviderModelLabel(label);
  const provider = parsed
    ? providers.find((candidate) => candidate.id === parsed.provider)
    : defaultProvider(providers);
  if (!provider) throw new Error(`Unknown provider "${parsed!.provider}"`);

  const [keyOverride, urlOverride] = await Promise.all([
    readSecret(providerApiKeySecretName(provider.id), userId),
    readSecret(providerBaseUrlSecretName(provider.id), userId),
  ]);
  return resolveProviderModel([{
    ...provider,
    apiKey: keyOverride?.trim() || provider.apiKey,
    baseUrl: urlOverride?.trim() || provider.baseUrl,
  }], parsed ? `${provider.id}/${parsed.model}` : null);
}

export async function createProviderRuntime(resolved: ResolvedProviderModel): Promise<ProviderModelRuntime> {
  const model: Model<"openai-completions"> = {
    id: resolved.modelId,
    name: resolved.modelName,
    api: "openai-completions",
    provider: resolved.providerId,
    baseUrl: resolved.baseUrl,
    reasoning: resolved.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
  };
  const provider = createProvider({
    id: resolved.providerId,
    name: resolved.providerName,
    baseUrl: resolved.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${resolved.providerName} API key`, []) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(resolved.providerId, async () => ({
    type: "api_key",
    key: resolved.apiKey,
  }));
  const models = createModels({ credentials });
  models.setProvider(provider);
  return { models, model, apiKey: resolved.apiKey };
}
