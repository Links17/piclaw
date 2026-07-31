import * as store from "@piclaw-cloud/store";
import type { GeneralSettingsSnapshot, CompactionSettingsSnapshot } from "@piclaw-cloud/store";
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
    return json(await store.getGeneralSettingsSnapshot(userId));
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const saved = await store.saveGeneralSettingsPatch(body as Partial<GeneralSettingsSnapshot>, userId);
  return json({ ok: true, settings: saved });
}

export async function handleCompactionSettingsRoute(req: Request): Promise<Response> {
  const userId = DEFAULT_USER_ID;
  if (req.method === "GET") {
    return json({ ok: true, settings: await store.getCompactionSettingsSnapshot(userId) });
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const saved = await store.saveCompactionSettingsPatch(body as Partial<CompactionSettingsSnapshot>, userId);
  return json({ ok: true, settings: saved });
}

export async function handleWorkspaceSettingsRoute(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  return json({
    ok: true,
    settings: {
      refreshIntervalSec: 60,
      folderPreviewDepth: 3,
    },
  });
}
