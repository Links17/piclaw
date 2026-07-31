import type { Api, Model, ModelsSimpleStreamOptions } from "@piclaw/agent-kernel";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { sanitizeProviderPayloadItemIds } from "./provider-request-sanitizer.js";
import { recordProviderResponseDiagnostics } from "./provider-response-diagnostics.js";

export type RuntimeModelExecutor = Pick<ModelRuntime, "streamSimple" | "completeSimple">;

let runtimeModelExecutor: RuntimeModelExecutor | null = null;

function composeOptions(model: Model<Api>, options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions {
  const callerPayload = options.onPayload;
  const callerResponse = options.onResponse;
  return {
    ...options,
    onPayload: async (payload, selectedModel) => {
      const effectiveModel = selectedModel ?? model;
      const transformed = callerPayload ? await callerPayload(payload, effectiveModel) : undefined;
      return sanitizeProviderPayloadItemIds(transformed ?? payload, {
        stripConnectionBoundIds: effectiveModel.provider === "github-copilot" && effectiveModel.api === "openai-responses",
      });
    },
    onResponse: async (response, selectedModel) => {
      recordProviderResponseDiagnostics(response.status, response.headers);
      await callerResponse?.(response, selectedModel);
    },
  };
}

/** Install the process-wide runtime-owned executor used by bundled path extensions. */
export function installRuntimeModelExecutor(modelRuntime: ModelRuntime): void {
  if (runtimeModelExecutor) throw new Error("Runtime model executor is already installed");
  runtimeModelExecutor = {
    streamSimple: (model, context, options) => modelRuntime.streamSimple(model, context, composeOptions(model, options)),
    completeSimple: (model, context, options) => modelRuntime.completeSimple(model, context, composeOptions(model, options)),
  };
}

export function getRuntimeModelExecutor(): RuntimeModelExecutor | null {
  return runtimeModelExecutor;
}

export function __setRuntimeModelExecutorForTests(executor: RuntimeModelExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Runtime model executor test override is test-only");
  runtimeModelExecutor = executor;
}
