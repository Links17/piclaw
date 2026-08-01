import { ensureSandbox } from "../sandbox/session.ts";
import { readFile } from "../sandbox/fs.ts";
import { chatJidToSessionId } from "../web-adapter.ts";

const ADDONS_NODE_MODULES = "/workspace/.pi/extensions/node_modules";

interface AddonPackageManifest {
  name?: string;
  pi?: {
    web?: {
      entries?: string[];
    };
  };
}

export interface InstalledAddonWebEntry {
  packageName: string;
  entry: string;
  url: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function listPackageDirs(sessionId: string): Promise<string[]> {
  const sandbox = await ensureSandbox(sessionId);
  const script = `
if [ ! -d ${shellQuote(ADDONS_NODE_MODULES)} ]; then exit 0; fi
find ${shellQuote(ADDONS_NODE_MODULES)} -mindepth 1 -maxdepth 3 -name package.json -print
`.trim();
  const result = await sandbox.commands.run(script, { timeoutMs: 30_000 });
  if (result.exitCode !== 0 && !result.stdout.trim()) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((pkgJsonPath) => pkgJsonPath.replace(/\/package\.json$/, ""));
}

export async function getInstalledAddonWebEntries(chatJid: string): Promise<InstalledAddonWebEntry[]> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) return [];
  let packageDirs: string[] = [];
  try {
    packageDirs = await listPackageDirs(sessionId);
  } catch {
    return [];
  }
  const sandbox = await ensureSandbox(sessionId);
  const entries: InstalledAddonWebEntry[] = [];
  for (const packageDir of packageDirs) {
    const packageJsonPath = `${packageDir}/package.json`;
    let manifest: AddonPackageManifest;
    try {
      manifest = JSON.parse(await readFile(sandbox, packageJsonPath)) as AddonPackageManifest;
    } catch {
      continue;
    }
    const packageName = typeof manifest.name === "string" ? manifest.name.trim() : "";
    const webEntries = Array.isArray(manifest?.pi?.web?.entries)
      ? manifest.pi.web.entries.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];
    if (!packageName || webEntries.length === 0) continue;
    for (const entry of webEntries) {
      const normalizedEntry = entry.replace(/^\.\//, "");
      const fullPath = `${packageDir}/${normalizedEntry}`;
      try {
        await readFile(sandbox, fullPath);
      } catch {
        continue;
      }
      entries.push({
        packageName,
        entry: normalizedEntry,
        url: `/agent/addons/assets/${encodeURIComponent(packageName)}/${normalizedEntry.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`,
      });
    }
  }
  return entries;
}

export function parseAddonAssetRequestPath(pathname: string): { packageName: string; relativePath: string } | null {
  const prefix = "/agent/addons/assets/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (rest.length < 2) return null;
  const packageName = rest[0].startsWith("@")
    ? rest[0].includes("/")
      ? rest[0]
      : rest.length >= 3
        ? `${rest[0]}/${rest[1]}`
        : ""
    : rest[0];
  const relativeSegments = rest[0].startsWith("@")
    ? rest[0].includes("/")
      ? rest.slice(1)
      : rest.slice(2)
    : rest.slice(1);
  const relativePath = relativeSegments.join("/");
  if (!packageName || !relativePath) return null;
  return { packageName, relativePath };
}

export function addonAssetAbsolutePath(packageName: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, "");
  return `${ADDONS_NODE_MODULES}/${packageName}/${normalized}`;
}

function mimeTypeForPath(assetPath: string): string {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export { mimeTypeForPath };
