/**
 * Read-only /workspace/* routes for cloud brain Web UI.
 */
import { getWorkspaceFilePreview, getWorkspaceRawFile, getWorkspaceTree } from "./sandbox-tree.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatJidFromUrl(url: URL): string | null {
  const raw = url.searchParams.get("chat_jid");
  return raw && raw.trim() ? raw.trim() : null;
}

/** Handle workspace routes; returns null when pathname is not a workspace route. */
export async function handleWorkspaceRoutes(req: Request, pathname: string): Promise<Response | null> {
  const url = new URL(req.url);

  if (req.method === "GET" && pathname === "/workspace/tree") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const showHidden =
        url.searchParams.get("show_hidden") === "1" || url.searchParams.get("show_hidden") === "true";
      const result = await getWorkspaceTree(
        chatJid,
        url.searchParams.get("path"),
        url.searchParams.get("depth"),
        showHidden,
      );
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 500);
    }
  }

  if (req.method === "GET" && pathname === "/workspace/raw") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await getWorkspaceRawFile(chatJid, url.searchParams.get("path"));
      const headers: Record<string, string> = { "Content-Type": body.contentType };
      if (url.searchParams.get("download") === "1") {
        const safeName = body.name.replace(/["\\]/g, "_");
        headers["Content-Disposition"] = `attachment; filename="${safeName}"`;
      }
      return new Response(body.content, { status: 200, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("directory")) return json({ error: message }, 400);
      if (message.includes("not found")) return json({ error: message }, 404);
      return json({ error: message }, 500);
    }
  }

  if (req.method === "GET" && pathname === "/workspace/file") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await getWorkspaceFilePreview(
        chatJid,
        url.searchParams.get("path"),
        url.searchParams.get("max"),
      );
      return json(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("directory")) return json({ error: message }, 400);
      if (message.includes("not found")) return json({ error: message }, 404);
      return json({ error: message }, 500);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/visibility") {
    return json({ ok: true });
  }

  if (req.method === "GET" && pathname === "/workspace/index-status") {
    return json({ state: "ready", indexed_file_count: 0, roots: ["workspace"] });
  }

  if (req.method === "GET" && pathname === "/workspace/branch") {
    return json({ branch: null });
  }

  return null;
}
