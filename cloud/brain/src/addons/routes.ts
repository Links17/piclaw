import { ensureSandbox } from "../sandbox/session.ts";
import { readFile } from "../sandbox/fs.ts";
import { chatJidToSessionId, ensureChatSession } from "../web-adapter.ts";
import { getAddonsCatalog } from "./catalog.ts";
import {
  addonAssetAbsolutePath,
  getInstalledAddonWebEntries,
  mimeTypeForPath,
  parseAddonAssetRequestPath,
} from "./web-entries.ts";
import { installAddonForChat, restartAddonRuntimeResponse, uninstallAddonForChat } from "./install.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function readRequestChatJid(url: URL): string {
  return url.searchParams.get("chat_jid")?.trim() || "web:default";
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function handleAddonRoutes(req: Request, pathname: string, url: URL): Promise<Response | null> {
  if (req.method === "GET" && pathname === "/agent/addons") {
    const chatJid = readRequestChatJid(url);
    try {
      await ensureChatSession(chatJid);
    } catch {
      // catalog still useful without a valid session
    }
    const result = await getAddonsCatalog(chatJid, url);
    if (result.status !== 200) return json({ error: result.error }, result.status);
    return json(result.body);
  }

  if (req.method === "GET" && pathname === "/agent/addons/web-entries") {
    const chatJid = readRequestChatJid(url);
    try {
      await ensureChatSession(chatJid);
      return json({ entries: await getInstalledAddonWebEntries(chatJid) });
    } catch {
      return json({ entries: [] });
    }
  }

  if (req.method === "GET" && pathname.startsWith("/agent/addons/assets/")) {
    const parsed = parseAddonAssetRequestPath(pathname);
    if (!parsed) return json({ error: "Invalid addon asset path" }, 400);
    const chatJid = readRequestChatJid(url);
    const sessionId = chatJidToSessionId(chatJid);
    if (!sessionId) return json({ error: "chat_jid required" }, 400);
    const absPath = addonAssetAbsolutePath(parsed.packageName, parsed.relativePath);
    if (absPath.includes("..")) return json({ error: "Invalid path" }, 400);
    try {
      await ensureChatSession(chatJid);
      const sandbox = await ensureSandbox(sessionId);
      const body = await readFile(sandbox, absPath);
      return new Response(body, {
        headers: {
          "Content-Type": mimeTypeForPath(parsed.relativePath),
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return json({ error: "Asset not found" }, 404);
    }
  }

  if (req.method === "POST" && pathname === "/agent/addons/install") {
    const chatJid = readRequestChatJid(url);
    const body = await readJsonBody(req);
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return json({ error: "Missing slug" }, 400);
    const result = await installAddonForChat(chatJid, slug, url);
    return json(result.body, result.status);
  }

  if (req.method === "POST" && pathname === "/agent/addons/uninstall") {
    const chatJid = readRequestChatJid(url);
    const body = await readJsonBody(req);
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return json({ error: "Missing slug" }, 400);
    const result = await uninstallAddonForChat(chatJid, slug, url);
    return json(result.body, result.status);
  }

  if (req.method === "POST" && pathname === "/agent/addons/restart") {
    const response = restartAddonRuntimeResponse();
    return json(response.body, response.status);
  }

  if ((req.method === "GET" || req.method === "POST") && pathname.startsWith("/agent/addons/api/")) {
    return json({
      error: "Add-on config API handlers are not loaded in cloud mode. Install add-ons in the workspace sandbox; settings panes that require runtime extension registration are unavailable until a cloud add-on host is wired.",
    }, 501);
  }

  return null;
}
