import * as store from "@piclaw-cloud/store";
import type { UserPreferences } from "@piclaw-cloud/store";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { getAvailableModels } from "./service.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function readRequestChatJid(url: URL): string {
  return url.searchParams.get("chat_jid")?.trim() || "web:default";
}

export async function handleModelsRoute(req: Request, url: URL): Promise<Response> {
  const chatJid = readRequestChatJid(url);
  const payload = await getAvailableModels(chatJid);
  return json({
    ...payload,
    oobe: {
      ...(payload.oobe ?? {}),
      provider_ready_completed_instance: Boolean(payload.oobe?.provider_ready_completed_instance),
    },
  });
}

export async function handleGeneralSettingsRoute(req: Request): Promise<Response> {
  const userId = DEFAULT_USER_ID;
  if (req.method === "GET") {
    const prefs = await store.getUserPreferences(userId);
    return json({
      scopedModelsOnly: Boolean(prefs.scopedModelsOnly),
      searchMatchMode: prefs.searchMatchMode ?? "or",
    });
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: UserPreferences = {};
  if (typeof body.scopedModelsOnly === "boolean") patch.scopedModelsOnly = body.scopedModelsOnly;
  if (typeof body.searchMatchMode === "string") patch.searchMatchMode = body.searchMatchMode;
  const settings = await store.updateUserPreferences(userId, patch);
  return json({
    ok: true,
    settings: {
      scopedModelsOnly: Boolean(settings.scopedModelsOnly),
      searchMatchMode: settings.searchMatchMode ?? "or",
    },
  });
}
