/**
 * Workspace write helpers — sandbox-backed mutations for the Web UI explorer.
 */
import type { Sandbox } from "../sandbox/client.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { writeFile } from "../sandbox/fs.ts";
import { WORKSPACE_ROOT, resolveWorkspacePath } from "../tools/path.ts";
import { chatJidToSessionId } from "../web-adapter.ts";
import { publishWorkspaceUpdate } from "./publish.ts";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRelPath(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";
  return raw.replace(/^\/+/, "").replace(/\/+/g, "/");
}

function absPathForRel(relPath: string): string {
  if (relPath === ".") return WORKSPACE_ROOT;
  return resolveWorkspacePath(relPath);
}

async function sessionSandbox(chatJid: string): Promise<Sandbox> {
  return ensureSandbox(chatJidToSessionId(chatJid));
}

async function pathKind(sbx: Sandbox, absPath: string): Promise<"file" | "dir" | "missing"> {
  const result = await sbx.commands.run(
    `if [ -f ${shellQuote(absPath)} ]; then echo file; elif [ -d ${shellQuote(absPath)} ]; then echo dir; else echo missing; fi`,
    { timeoutMs: 30_000 },
  );
  const kind = result.stdout.trim();
  if (kind === "file" || kind === "dir") return kind;
  return "missing";
}

function formatMtime(epochSec: number): string | null {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Date(epochSec * 1000).toISOString();
}

export async function statWorkspacePath(chatJid: string, pathParam: string | null) {
  const sbx = await sessionSandbox(chatJid);
  const relPath = normalizeRelPath(pathParam);
  const absPath = absPathForRel(relPath);
  const kind = await pathKind(sbx, absPath);
  if (kind === "missing") throw new Error("File not found");
  const statResult = await sbx.commands.run(`stat -c '%s %Y' ${shellQuote(absPath)} 2>/dev/null || echo '0 0'`);
  const [sizeRaw, mtimeRaw] = statResult.stdout.trim().split(/\s+/);
  return {
    path: relPath,
    mtime: formatMtime(Number(mtimeRaw)),
    size: Number(sizeRaw) || 0,
  };
}

export async function updateWorkspaceFileContent(chatJid: string, pathParam: string, content: string) {
  const sbx = await sessionSandbox(chatJid);
  const relPath = normalizeRelPath(pathParam);
  if (relPath === ".") throw new Error("Invalid path");
  const absPath = absPathForRel(relPath);
  const kind = await pathKind(sbx, absPath);
  if (kind === "missing") throw new Error("File not found");
  if (kind === "dir") throw new Error("Path is a directory");
  await writeFile(sbx, absPath, content ?? "");
  await publishWorkspaceUpdate(chatJidToSessionId(chatJid), absPath);
  return { ok: true, path: relPath };
}

export async function createWorkspaceFileEntry(
  chatJid: string,
  parentPath: string,
  name: string,
  content = "",
) {
  const sbx = await sessionSandbox(chatJid);
  const parentRel = normalizeRelPath(parentPath);
  const fileName = name.trim();
  if (!fileName || fileName.includes("/")) throw new Error("Invalid file name");
  const relPath = parentRel === "." ? fileName : `${parentRel}/${fileName}`;
  const absPath = absPathForRel(relPath);
  const kind = await pathKind(sbx, absPath);
  if (kind !== "missing") throw new Error("Path already exists");
  await sbx.commands.run(`mkdir -p ${shellQuote(absPath.replace(/\/[^/]+$/, ""))}`);
  await writeFile(sbx, absPath, content ?? "");
  await publishWorkspaceUpdate(chatJidToSessionId(chatJid), absPath);
  return { ok: true, path: relPath };
}

export async function deleteWorkspacePath(chatJid: string, pathParam: string) {
  const sbx = await sessionSandbox(chatJid);
  const relPath = normalizeRelPath(pathParam);
  if (relPath === ".") throw new Error("Invalid path");
  const absPath = absPathForRel(relPath);
  const kind = await pathKind(sbx, absPath);
  if (kind === "missing") throw new Error("File not found");
  const cmd = kind === "dir"
    ? `rm -rf ${shellQuote(absPath)}`
    : `rm -f ${shellQuote(absPath)}`;
  const result = await sbx.commands.run(cmd, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Delete failed");
  await publishWorkspaceUpdate(chatJidToSessionId(chatJid), absPath);
  return { ok: true, path: relPath };
}

export async function renameWorkspacePath(chatJid: string, pathParam: string, newName: string) {
  const sbx = await sessionSandbox(chatJid);
  const relPath = normalizeRelPath(pathParam);
  const name = newName.trim();
  if (!name || name.includes("/")) throw new Error("Invalid name");
  const absPath = absPathForRel(relPath);
  const kind = await pathKind(sbx, absPath);
  if (kind === "missing") throw new Error("File not found");
  const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
  const nextRel = parent === "." ? name : `${parent}/${name}`;
  const nextAbs = absPathForRel(nextRel);
  const result = await sbx.commands.run(`mv ${shellQuote(absPath)} ${shellQuote(nextAbs)}`, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Rename failed");
  await publishWorkspaceUpdate(chatJidToSessionId(chatJid), nextAbs);
  return { ok: true, path: nextRel, old_path: relPath };
}

export async function moveWorkspacePath(chatJid: string, pathParam: string, targetDir: string) {
  const sbx = await sessionSandbox(chatJid);
  const relPath = normalizeRelPath(pathParam);
  const targetRel = normalizeRelPath(targetDir);
  const absPath = absPathForRel(relPath);
  const targetAbs = absPathForRel(targetRel);
  const kind = await pathKind(sbx, absPath);
  if (kind === "missing") throw new Error("File not found");
  const targetKind = await pathKind(sbx, targetAbs);
  if (targetKind === "missing") {
    await sbx.commands.run(`mkdir -p ${shellQuote(targetAbs)}`);
  } else if (targetKind !== "dir") {
    throw new Error("Target is not a directory");
  }
  const baseName = relPath.split("/").pop() ?? relPath;
  const nextRel = targetRel === "." ? baseName : `${targetRel}/${baseName}`;
  const nextAbs = absPathForRel(nextRel);
  const result = await sbx.commands.run(`mv ${shellQuote(absPath)} ${shellQuote(nextAbs)}`, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Move failed");
  await publishWorkspaceUpdate(chatJidToSessionId(chatJid), nextAbs);
  return { ok: true, path: nextRel, old_path: relPath };
}

export async function countWorkspaceFiles(chatJid: string): Promise<number> {
  const sbx = await sessionSandbox(chatJid);
  const result = await sbx.commands.run(
    `find ${shellQuote(WORKSPACE_ROOT)} -type f 2>/dev/null | wc -l | tr -d ' '`,
    { timeoutMs: 120_000 },
  );
  const count = Number(result.stdout.trim());
  return Number.isFinite(count) ? count : 0;
}
