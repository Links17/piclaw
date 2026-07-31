/**
 * runtime/provider-bootstrap.ts – Optional model provider registration at startup.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@piclaw/agent-kernel";
import { createLogger } from "../utils/logger.js";

export type AzureProviderBootstrapHandle = { stop: () => void; refresh: () => Promise<void> };
export type AzureProviderBootstrapModule = {
  startAzureProviderBootstrap: (register: (provider: Provider) => void) => AzureProviderBootstrapHandle;
};

const log = createLogger("runtime.provider-bootstrap");

/** Minimal AgentPool contract needed to register optional model providers. */
export interface ProviderBootstrapAgentPool {
  hasProviderModels(provider: string): boolean;
  registerModelProvider(
    providerName: string,
    config: Parameters<ModelRegistry["registerProvider"]>[1]
  ): void;
  registerNativeModelProvider(provider: Provider): void;
  getModelRegistry(): ModelRegistry;
}

const AZURE_OPENAI_PROVIDER = "azure-openai";
const AZURE_FOUNDRY_PROVIDER = "azure-foundry";

const AZURE_BOOTSTRAP_MODULE_URL = new URL("../../extensions/integrations/azure-openai.ts", import.meta.url).href;

let activeAzureBootstrap: AzureProviderBootstrapHandle | null = null;
let loadAzureBootstrapModuleImpl: () => Promise<AzureProviderBootstrapModule> = async () =>
  await import(AZURE_BOOTSTRAP_MODULE_URL) as AzureProviderBootstrapModule;

function hasAzureBootstrapEnv(): boolean {
  return Boolean(process.env.AOAI_BASE_URL || process.env.FOUNDRY_BASE_URL || process.env.AOAI2_BASE_URL);
}

/** Ensure optional Azure providers are discoverable in /model at startup. */
export async function registerOptionalProviders(agentPool: ProviderBootstrapAgentPool): Promise<void> {
  if (!hasAzureBootstrapEnv()) return;
  if (activeAzureBootstrap) return;

  const mod = await loadAzureBootstrapModuleImpl();
  activeAzureBootstrap = mod.startAzureProviderBootstrap((provider) => {
    agentPool.registerNativeModelProvider(provider);
  });
  try {
    await activeAzureBootstrap.refresh();
  } catch (error) {
    activeAzureBootstrap.stop();
    activeAzureBootstrap = null;
    throw error;
  }

  log.info("Registered Azure optional providers via process bootstrap", {
    operation: "register_optional_providers.azure",
    hasAzureOpenAiModels: agentPool.hasProviderModels(AZURE_OPENAI_PROVIDER),
    hasAzureFoundryModels: agentPool.hasProviderModels(AZURE_FOUNDRY_PROVIDER),
  });
}

export function stopOptionalProviders(): void {
  activeAzureBootstrap?.stop();
  activeAzureBootstrap = null;
}

export function setProviderBootstrapLoaderForTests(
  loader: null | (() => Promise<AzureProviderBootstrapModule>),
): void {
  loadAzureBootstrapModuleImpl = loader ?? (async () => await import(AZURE_BOOTSTRAP_MODULE_URL) as AzureProviderBootstrapModule);
}

export function resetProviderBootstrapForTests(): void {
  stopOptionalProviders();
  loadAzureBootstrapModuleImpl = async () => await import(AZURE_BOOTSTRAP_MODULE_URL) as AzureProviderBootstrapModule;
}
