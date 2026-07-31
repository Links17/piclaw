import * as store from "@piclaw-cloud/store";
import type { Model } from "./pi.ts";
import { CLOUD_KERNEL_PROVIDER_ID, createCloudKernelModel } from "./provider.ts";
import { config } from "../config.ts";
import { getKernelRuntime } from "./runtime.ts";

function parseModelLabel(label: string | null | undefined): { provider: string; id: string } | null {
  const text = typeof label === "string" ? label.trim() : "";
  if (!text.includes("/")) return null;
  const slash = text.indexOf("/");
  const provider = text.slice(0, slash).trim();
  const id = text.slice(slash + 1).trim();
  if (!provider || !id) return null;
  return { provider, id };
}

/** Resolve the effective kernel model for a session (honours persisted model_label). */
export async function resolveSessionKernelModel(sessionId: string): Promise<Model<"openai-completions">> {
  const kernel = getKernelRuntime();
  if (!kernel) {
    throw new Error("Agent kernel is not initialized");
  }

  const prefs = await store.getSessionModelPrefs(sessionId);
  const parsed = parseModelLabel(prefs.modelLabel);
  if (!parsed) return kernel.model;

  if (parsed.provider !== kernel.providerId && parsed.provider !== CLOUD_KERNEL_PROVIDER_ID) {
    return kernel.model;
  }

  if (parsed.id === kernel.model.id) return kernel.model;

  return createCloudKernelModel({
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: parsed.id,
    contextWindow: kernel.model.contextWindow,
    maxTokens: kernel.model.maxTokens,
  });
}

export function resolveModelIdForLogging(sessionModel: Model<string>, fallback = config.openaiModel): string {
  return sessionModel?.id?.trim() || fallback;
}
