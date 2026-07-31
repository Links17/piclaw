import * as store from "@piclaw-cloud/store";
import type { Model } from "./pi.ts";
import type { CloudKernelRuntime } from "./provider.ts";
import { config } from "../config.ts";
import {
  buildProviderRegistryEntries,
  createKeychainSecretReader,
  createProviderRuntime,
  resolveProviderModelForUser,
} from "./provider-registry.ts";

export interface SessionKernelModel {
  models: CloudKernelRuntime["models"];
  model: Model<"openai-completions">;
  apiKey: string;
  providerId: string;
  modelLabel: string;
}

function keychainEncryptionKey(): string {
  return config.devApiKey || "piclaw-cloud-keychain-dev";
}

/** Resolve the effective provider runtime for a session (honours persisted model_label). */
export async function resolveSessionKernelModel(sessionId: string): Promise<SessionKernelModel> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error("Unknown session");

  const prefs = await store.getSessionModelPrefs(sessionId);
  const resolved = await resolveProviderModelForUser(
    buildProviderRegistryEntries({
      openai: {
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
      },
      providers: config.providers,
    }),
    prefs.modelLabel,
    session.user_id,
    createKeychainSecretReader(keychainEncryptionKey()),
  );
  const runtime = await createProviderRuntime(resolved);
  return {
    ...runtime,
    providerId: resolved.providerId,
    modelLabel: `${resolved.providerId}/${resolved.modelId}`,
  };
}

export function resolveModelIdForLogging(sessionModel: Model<string>, fallback = config.openaiModel): string {
  return sessionModel?.id?.trim() || fallback;
}
