import {
  createCloudKernelRuntime,
  type CloudKernelRuntime,
} from "./provider.ts";
import { config } from "../config.ts";
import { isLlmMockEnabled } from "../llm.ts";
import { createMockKernelRuntime } from "./mock-runtime.ts";

let runtime: CloudKernelRuntime | null = null;
let initPromise: Promise<CloudKernelRuntime | null> | null = null;

export function isKernelConfigured(): boolean {
  return Boolean(config.openaiBaseUrl && config.openaiApiKey);
}

export function isKernelAvailable(): boolean {
  return isKernelConfigured() || isLlmMockEnabled();
}

export async function initKernelRuntime(): Promise<CloudKernelRuntime | null> {
  if (runtime) return runtime;
  if (!isKernelAvailable()) return null;

  if (!initPromise) {
    initPromise = (async () => {
      if (isLlmMockEnabled()) {
        runtime = createMockKernelRuntime();
        return runtime;
      }
      runtime = await createCloudKernelRuntime({
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
      });
      return runtime;
    })();
  }
  return initPromise;
}

export function getKernelRuntime(): CloudKernelRuntime | null {
  return runtime;
}
