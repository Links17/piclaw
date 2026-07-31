import {
  createCloudKernelRuntime,
  type CloudKernelRuntime,
} from "@piclaw/agent-kernel";
import { config } from "../config.ts";

let runtime: CloudKernelRuntime | null = null;
let initPromise: Promise<CloudKernelRuntime | null> | null = null;

export function isKernelConfigured(): boolean {
  return Boolean(config.openaiBaseUrl && config.openaiApiKey);
}

export async function initKernelRuntime(): Promise<CloudKernelRuntime | null> {
  if (!isKernelConfigured()) return null;
  if (runtime) return runtime;
  if (!initPromise) {
    initPromise = createCloudKernelRuntime({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
    }).then((value) => {
      runtime = value;
      return value;
    });
  }
  return initPromise;
}

export function getKernelRuntime(): CloudKernelRuntime | null {
  return runtime;
}
