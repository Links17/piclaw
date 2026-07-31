/**
 * Workspace routes — sandbox-backed explorer API for cloud Web UI.
 */
import * as store from "@piclaw-cloud/store";
import { chatJidToSessionId } from "../web-adapter.ts";
import { getWorkspaceFilePreview, getWorkspaceRawFile, getWorkspaceTree } from "./sandbox-tree.ts";
import {
  countWorkspaceFiles,
  createWorkspaceFileEntry,
  deleteWorkspacePath,
  moveWorkspacePath,
  renameWorkspacePath,
  statWorkspacePath,
  updateWorkspaceFileContent,
} from "./sandbox-write.ts";

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

  if (req.method === "GET" && pathname === "/workspace/stat") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      return json(await statWorkspacePath(chatJid, url.searchParams.get("path")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  }

  if (req.method === "PUT" && pathname === "/workspace/file") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await req.json().catch(() => ({})) as { path?: string; content?: string };
      if (!body.path) return json({ error: "Missing path" }, 400);
      return json(await updateWorkspaceFileContent(chatJid, body.path, body.content ?? ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/file") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await req.json().catch(() => ({})) as { path?: string; name?: string; content?: string };
      if (!body.name) return json({ error: "Missing name" }, 400);
      return json(await createWorkspaceFileEntry(chatJid, body.path ?? ".", body.name, body.content ?? ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("already exists") ? 409 : message.includes("not found") ? 404 : 400;
      return json({ error: message }, status);
    }
  }

  if (req.method === "DELETE" && pathname === "/workspace/file") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "Missing path" }, 400);
      return json(await deleteWorkspacePath(chatJid, path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/rename") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await req.json().catch(() => ({})) as { path?: string; name?: string };
      if (!body.path || !body.name) return json({ error: "Missing path or name" }, 400);
      return json(await renameWorkspacePath(chatJid, body.path, body.name));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/move") {
    try {
      const chatJid = chatJidFromUrl(url);
      if (!chatJid) return json({ error: "chat_jid required" }, 400);
      const body = await req.json().catch(() => ({})) as { path?: string; target?: string };
      if (!body.path || body.target == null) return json({ error: "Missing path or target" }, 400);
      return json(await moveWorkspacePath(chatJid, body.path, body.target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/reindex") {
    const chatJid = chatJidFromUrl(url);
    if (!chatJid) return json({ error: "chat_jid required" }, 400);
    try {
      const indexedFileCount = await countWorkspaceFiles(chatJid);
      return json({
        state: "ready",
        has_sandbox: true,
        indexed_file_count: indexedFileCount,
        roots: ["workspace"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 500);
    }
  }

  if (req.method === "POST" && pathname === "/workspace/visibility") {
    return json({ ok: true });
  }

  if (req.method === "GET" && pathname === "/workspace/index-status") {
    const chatJid = chatJidFromUrl(url);
    let hasSandbox = false;
    let indexedFileCount = 0;
    if (chatJid) {
      const session = await store.getSession(chatJidToSessionId(chatJid));
      hasSandbox = Boolean(typeof session?.sandbox_id === "string" && session.sandbox_id.trim());
      if (hasSandbox) {
        try {
          indexedFileCount = await countWorkspaceFiles(chatJid);
        } catch {
          indexedFileCount = 0;
        }
      }
    }
    return json({
      state: hasSandbox ? "ready" : "unavailable",
      has_sandbox: hasSandbox,
      indexed_file_count: indexedFileCount,
      roots: ["workspace"],
    });
  }

  if (req.method === "GET" && pathname === "/workspace/branch") {
    return json({ branch: null });
  }

  return null;
}
