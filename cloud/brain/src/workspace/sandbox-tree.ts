/**
 * Read-only workspace tree from CubeSandbox — matches runtime/web tree node shape.
 */
import type { Sandbox } from "../sandbox/client.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { readFile } from "../sandbox/fs.ts";
import { WORKSPACE_ROOT, resolveWorkspacePath } from "../tools/path.ts";
import { chatJidToSessionId } from "../web-adapter.ts";

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number | null;
  mtime: string | null;
  child_count: number | undefined;
  children: WorkspaceTreeNode[] | undefined;
}

interface DirEntry {
  name: string;
  relPath: string;
  type: "dir" | "file";
  size: number | null;
  mtime: string | null;
}

const MAX_ENTRIES = 5000;

function normalizeRelPath(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";
  return raw.replace(/^\/+/, "").replace(/\/+/g, "/");
}

function absPathForRel(relPath: string): string {
  if (relPath === ".") return WORKSPACE_ROOT;
  return resolveWorkspacePath(relPath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatMtime(epochSec: number): string | null {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Date(epochSec * 1000).toISOString();
}

async function listEntries(sbx: Sandbox, absDir: string, showHidden: boolean): Promise<DirEntry[]> {
  const script = `
cd ${shellQuote(absDir)} 2>/dev/null || exit 1
for item in * .[^.]* ..?*; do
  [ -e "$item" ] || continue
  [ "$item" = "." ] || [ "$item" = ".." ] && continue
  if [ -d "$item" ]; then kind=d; else kind=f; fi
  size=$(stat -c '%s' "$item" 2>/dev/null || echo 0)
  mtime=$(stat -c '%Y' "$item" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t%s\\t%s\\n' "$kind" "$item" "$size" "$mtime"
done
`.trim();
  const result = await sbx.commands.run(script, { timeoutMs: 60_000 });
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return [];
  }

  const parentRel = absDir === WORKSPACE_ROOT ? "" : absDir.slice(WORKSPACE_ROOT.length + 1);
  const entries: DirEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [kind, name, sizeRaw, mtimeRaw] = trimmed.split("\t");
    if (!name || name === "." || name === "..") continue;
    if (!showHidden && name.startsWith(".")) continue;
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    entries.push({
      name,
      relPath,
      type: kind === "d" ? "dir" : "file",
      size: kind === "d" ? null : Number(sizeRaw) || 0,
      mtime: formatMtime(Number(mtimeRaw)),
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function buildNode(
  sbx: Sandbox,
  relPath: string,
  depth: number,
  showHidden: boolean,
  state: { count: number; truncated: boolean },
): Promise<WorkspaceTreeNode> {
  const absPath = absPathForRel(relPath);
  const name = relPath === "." ? "workspace" : relPath.split("/").pop() ?? relPath;

  const statResult = await sbx.commands.run(
    `if [ -d ${shellQuote(absPath)} ]; then echo dir; elif [ -f ${shellQuote(absPath)} ]; then echo file; else echo missing; fi`,
    { timeoutMs: 30_000 },
  );
  const kind = statResult.stdout.trim();
  if (kind === "missing") {
    throw new Error("Path not found");
  }

  const node: WorkspaceTreeNode = {
    name,
    path: relPath,
    type: kind === "dir" ? "dir" : "file",
    size: null,
    mtime: null,
    child_count: undefined,
    children: kind === "dir" ? [] : undefined,
  };

  if (kind === "file") {
    const sizeResult = await sbx.commands.run(`stat -c '%s %Y' ${shellQuote(absPath)} 2>/dev/null || echo '0 0'`);
    const [sizeRaw, mtimeRaw] = sizeResult.stdout.trim().split(/\s+/);
    node.size = Number(sizeRaw) || 0;
    node.mtime = formatMtime(Number(mtimeRaw));
    return node;
  }

  if (depth <= 0) {
    node.children = undefined;
    return node;
  }

  const entries = await listEntries(sbx, absPath, showHidden);
  node.child_count = entries.length;
  node.children = [];

  for (const entry of entries) {
    state.count += 1;
    if (state.count > MAX_ENTRIES) {
      state.truncated = true;
      break;
    }
    if (entry.type === "file") {
      node.children.push({
        name: entry.name,
        path: entry.relPath,
        type: "file",
        size: entry.size,
        mtime: entry.mtime,
        child_count: undefined,
        children: undefined,
      });
      continue;
    }
    if (depth <= 1) {
      node.children.push({
        name: entry.name,
        path: entry.relPath,
        type: "dir",
        size: null,
        mtime: entry.mtime,
        child_count: undefined,
        children: undefined,
      });
      continue;
    }
    node.children.push(await buildNode(sbx, entry.relPath, depth - 1, showHidden, state));
  }

  return node;
}

export async function getWorkspaceTree(
  chatJid: string,
  pathParam: string | null,
  depthParam: string | null,
  showHidden: boolean,
): Promise<{ root: WorkspaceTreeNode; truncated: boolean }> {
  const sessionId = chatJidToSessionId(chatJid);
  const sbx = await ensureSandbox(sessionId);
  const relPath = normalizeRelPath(pathParam);
  const depthRaw = parseInt(depthParam || "2", 10);
  const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 1), 8) : 2;
  const state = { count: 0, truncated: false };
  const root = await buildNode(sbx, relPath, depth, showHidden, state);
  return { root, truncated: state.truncated };
}

export async function getWorkspaceFilePreview(
  chatJid: string,
  pathParam: string | null,
  maxParam: string | null,
): Promise<Record<string, unknown>> {
  const sessionId = chatJidToSessionId(chatJid);
  const sbx = await ensureSandbox(sessionId);
  const relPath = normalizeRelPath(pathParam);
  if (relPath === ".") throw new Error("Path is a directory");
  const absPath = absPathForRel(relPath);

  const kindResult = await sbx.commands.run(
    `if [ -f ${shellQuote(absPath)} ]; then echo file; elif [ -d ${shellQuote(absPath)} ]; then echo dir; else echo missing; fi`,
  );
  const kind = kindResult.stdout.trim();
  if (kind === "missing") throw new Error("File not found");
  if (kind === "dir") throw new Error("Path is a directory");

  const statResult = await sbx.commands.run(`stat -c '%s %Y' ${shellQuote(absPath)} 2>/dev/null || echo '0 0'`);
  const [sizeRaw, mtimeRaw] = statResult.stdout.trim().split(/\s+/);
  const size = Number(sizeRaw) || 0;
  const maxParsed = parseInt(maxParam || "", 10);
  const maxBytes = Number.isFinite(maxParsed) ? Math.min(Math.max(maxParsed, 1024), 512_000) : 20_000;

  const content = await readFile(sbx, absPath);
  const text = content.slice(0, maxBytes);
  const truncated = content.length > maxBytes;
  const name = relPath.split("/").pop() ?? relPath;
  return {
    path: relPath,
    name,
    kind: "text",
    content_type: contentTypeForName(name),
    size,
    mtime: formatMtime(Number(mtimeRaw)),
    text,
    truncated,
  };
}

function contentTypeForName(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  const map: Record<string, string> = {
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/typescript; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  };
  return map[ext] ?? "text/plain; charset=utf-8";
}

export async function getWorkspaceRawFile(
  chatJid: string,
  pathParam: string | null,
): Promise<{ content: string; contentType: string; name: string }> {
  const sessionId = chatJidToSessionId(chatJid);
  const sbx = await ensureSandbox(sessionId);
  const relPath = normalizeRelPath(pathParam);
  if (relPath === ".") throw new Error("Path is a directory");
  const absPath = absPathForRel(relPath);

  const kindResult = await sbx.commands.run(
    `if [ -f ${shellQuote(absPath)} ]; then echo file; elif [ -d ${shellQuote(absPath)} ]; then echo dir; else echo missing; fi`,
  );
  const kind = kindResult.stdout.trim();
  if (kind === "missing") throw new Error("File not found");
  if (kind === "dir") throw new Error("Path is a directory");

  const content = await readFile(sbx, absPath);
  const name = relPath.split("/").pop() ?? relPath;
  return { content, contentType: contentTypeForName(name), name };
}
