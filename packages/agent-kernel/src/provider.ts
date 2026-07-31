import {
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const CLOUD_KERNEL_PROVIDER_ID = "piclaw-cloud";

export interface CloudKernelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CloudKernelRuntime {
  models: MutableModels;
  model: Model<"openai-completions">;
  providerId: string;
}

export function createCloudKernelModel(config: CloudKernelConfig): Model<"openai-completions"> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: CLOUD_KERNEL_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 8192,
  };
}

/** Build a pi-ai Models collection wired to an OpenAI-compatible endpoint. */
export async function createCloudKernelRuntime(config: CloudKernelConfig): Promise<CloudKernelRuntime> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const model = createCloudKernelModel(config);

  const provider = createProvider({
    id: CLOUD_KERNEL_PROVIDER_ID,
    name: "PiClaw Cloud",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: [model],
    api: openAICompletionsApi(),
  });

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(CLOUD_KERNEL_PROVIDER_ID, async () => ({
    type: "api_key",
    key: config.apiKey,
  }));

  const models = createModels({ credentials });
  models.setProvider(provider);

  return { models, model, providerId: CLOUD_KERNEL_PROVIDER_ID };
}
