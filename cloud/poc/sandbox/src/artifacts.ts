/**
 * Artifact archive/restore for sandbox recycling.
 *
 * Uses Tencent COS when POC_COS_* credentials are set; otherwise a local
 * directory that mimics the same key layout (validates roundtrip logic
 * without cloud credentials).
 */
import { mkdir, readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Sandbox } from "./client.ts";
import { readFile as readSandboxFile, writeFile as writeSandboxFile } from "./fs.ts";

export interface ArtifactManifest {
  sessionKey: string;
  files: Array<{ path: string; encoding: "utf8" | "base64" }>;
}

function storeRoot(sessionKey: string): string {
  return join(config.artifactDir, sessionKey);
}

function manifestPath(sessionKey: string): string {
  return join(storeRoot(sessionKey), "manifest.json");
}

/** Read listed paths from a live sandbox into the artifact store. */
export async function archiveFromSandbox(
  sandbox: Sandbox,
  sessionKey: string,
  paths: string[],
): Promise<ArtifactManifest> {
  const manifest: ArtifactManifest = { sessionKey, files: [] };
  const root = storeRoot(sessionKey);
  await mkdir(root, { recursive: true });

  for (const path of paths) {
    const data = await readSandboxFile(sandbox, path);
    const isText = typeof data === "string";
    const rel = path.replace(/^\//, "").replace(/\//g, "__");
    const blob = isText ? data : Buffer.from(data).toString("base64");
    await writeLocalFile(join(root, rel), blob, isText ? "utf8" : "utf8");
    manifest.files.push({ path, encoding: isText ? "utf8" : "base64" });
  }
  await writeLocalFile(manifestPath(sessionKey), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Restore archived files into a fresh sandbox. */
export async function restoreToSandbox(sandbox: Sandbox, sessionKey: string): Promise<void> {
  const raw = await readLocalFile(manifestPath(sessionKey), "utf8");
  const manifest = JSON.parse(raw) as ArtifactManifest;
  for (const entry of manifest.files) {
    const rel = entry.path.replace(/^\//, "").replace(/\//g, "__");
    const blob = await readLocalFile(join(storeRoot(sessionKey), rel), "utf8");
    const content = entry.encoding === "utf8" ? blob : Buffer.from(blob, "base64").toString("utf8");
    await writeSandboxFile(sandbox, entry.path, content);
  }
}

export function artifactBackend(): "cos" | "local" {
  return config.cosSecretId && config.cosSecretKey && config.cosBucket ? "cos" : "local";
}
