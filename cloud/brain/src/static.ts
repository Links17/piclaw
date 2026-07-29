/**
 * Lightweight static file serving for cloud brain — same-origin Web UI.
 */
import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const STATIC_DIR = resolve(process.env.PICLAW_WEB_STATIC_DIR || resolve(REPO_ROOT, "runtime", "web", "static"));
const EDITOR_VENDOR_DIR = resolve(REPO_ROOT, "runtime", "extensions", "viewers", "editor", "vendor");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function isPathWithin(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function cacheControlFor(relPath: string, ext: string): string {
  if (ext === ".html" || relPath === "sw.js" || relPath.includes("/dist/")) {
    return "no-cache, no-store, must-revalidate";
  }
  return "public, max-age=3600";
}

function fileResponse(filePath: string, relPath: string, req: Request): Response | null {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (!stat.isFile()) return null;

  const ext = extname(filePath);
  const contentType = relPath.endsWith("manifest.json")
    ? "application/manifest+json; charset=utf-8"
    : MIME_TYPES[ext] || "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControlFor(relPath, ext),
  };
  if (relPath === "sw.js") {
    headers["Service-Worker-Allowed"] = "/";
  }
  if (req.method === "HEAD") {
    headers["Content-Length"] = String(stat.size);
    return new Response(null, { status: 200, headers });
  }
  return new Response(Bun.file(filePath), { status: 200, headers });
}

function serveFromRoot(rootDir: string, relPath: string, req: Request): Response | null {
  if (!relPath || relPath.includes("..") || relPath.startsWith("/")) return null;
  const filePath = resolve(rootDir, relPath);
  if (!isPathWithin(rootDir, filePath)) return null;
  return fileResponse(filePath, relPath, req);
}

/** Serve static assets for the Web UI; returns null when the path is not a static route. */
export function serveStaticRequest(req: Request): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/classic" || pathname === "/classic/") {
    return serveFromRoot(STATIC_DIR, "classic/index.html", req);
  }

  if (pathname === "/sw.js") {
    return serveFromRoot(STATIC_DIR, "sw.js", req);
  }

  if (pathname.startsWith("/static/")) {
    const relPath = pathname.slice("/static/".length);
    return serveFromRoot(STATIC_DIR, relPath, req);
  }

  if (pathname.startsWith("/editor-vendor/")) {
    let relPath = pathname.slice("/editor-vendor/".length);
    const queryIndex = relPath.indexOf("?");
    if (queryIndex >= 0) relPath = relPath.slice(0, queryIndex);
    if (!relPath) relPath = "codemirror.js";
    return serveFromRoot(EDITOR_VENDOR_DIR, relPath, req);
  }

  return null;
}
