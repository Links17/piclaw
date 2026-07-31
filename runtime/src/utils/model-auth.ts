import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@piclaw/agent-kernel";

/** Canonical request auth needed only by direct provider-native HTTP helpers. */
export type ModelRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; baseUrl?: string }
  | { ok: false; error: string };

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Resolve auth through the process-wide ModelRuntime for a direct HTTP request.
 * Normal model completions must call ModelRuntime.stream/streamSimple instead,
 * which keeps auth, provider environment, and credential-specific base URL
 * inside the canonical request assembly path.
 */
export async function resolveModelRequestAuth(
  modelRuntime: Pick<ModelRuntime, "getAuth">,
  model: Model<Api>,
): Promise<ModelRequestAuth> {
  if (!modelRuntime || typeof modelRuntime.getAuth !== "function") {
    return { ok: false, error: `No model runtime is available for ${model.provider}/${model.id}.` };
  }

  try {
    const resolved = await modelRuntime.getAuth(model);
    if (!resolved) return { ok: false, error: `No credentials available for ${model.provider}/${model.id}.` };
    return {
      ok: true,
      apiKey: resolved.auth.apiKey,
      headers: stringHeaders(resolved.auth.headers),
      env: resolved.env,
      baseUrl: resolved.auth.baseUrl,
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
