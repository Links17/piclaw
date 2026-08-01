const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/rcarmo/piclaw-addons/main/catalog.json";
const DEFAULT_CATALOG_URLS = [DEFAULT_CATALOG_URL] as const;
const CATALOG_CACHE_MS = 5 * 60 * 1000;

interface CatalogAddonInstall {
  kind?: string;
  spec?: string;
}

export interface CatalogAddon {
  slug: string;
  name: string;
  version?: string;
  type?: string;
  description?: string;
  path?: string;
  homepage?: string;
  tags?: string[];
  skills?: string[];
  install?: CatalogAddonInstall;
}

interface CatalogData {
  version?: number;
  source?: string;
  addons: CatalogAddon[];
}

const catalogCache = new Map<string, { data: unknown; ts: number }>();

function parseCatalogUrlList(values: Array<string | null | undefined>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of String(value || "").split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean)) {
      if (seen.has(part)) continue;
      seen.add(part);
      urls.push(part);
    }
  }
  return urls;
}

export function resolveRequestedCatalogUrls(url?: URL): string[] {
  const requested = parseCatalogUrlList(url?.searchParams.getAll("catalog_url") || []);
  if (requested.length === 0) return [...DEFAULT_CATALOG_URLS];
  const merged: string[] = [...DEFAULT_CATALOG_URLS];
  for (const entry of requested) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged;
}

async function fetchCatalog(catalogUrl: string): Promise<CatalogData | null> {
  const url = String(catalogUrl || "").trim();
  if (!url) return null;
  const now = Date.now();
  const cached = catalogCache.get(url);
  if (cached && now - cached.ts < CATALOG_CACHE_MS) {
    return cached.data as CatalogData;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    catalogCache.set(url, { data, ts: now });
    return data as CatalogData;
  } catch {
    return (catalogCache.get(url)?.data as CatalogData | undefined) ?? null;
  }
}

function mergeCatalogs(catalogs: CatalogData[]): CatalogData | null {
  const validCatalogs = catalogs.filter((catalog) => catalog && Array.isArray(catalog.addons));
  if (validCatalogs.length === 0) return null;
  const addons: CatalogAddon[] = [];
  const seenKeys = new Set<string>();
  const sources: string[] = [];
  let version = 0;
  for (const catalog of validCatalogs) {
    version = Math.max(version, Number(catalog.version) || 0);
    const source = typeof catalog.source === "string" ? catalog.source.trim() : "";
    if (source && !sources.includes(source)) sources.push(source);
    for (const addon of catalog.addons) {
      const slugKey = typeof addon?.slug === "string" && addon.slug.trim() ? `slug:${addon.slug.trim()}` : "";
      const nameKey = typeof addon?.name === "string" && addon.name.trim() ? `name:${addon.name.trim()}` : "";
      const dedupeKey = slugKey || nameKey;
      if (!dedupeKey || seenKeys.has(dedupeKey)) continue;
      if (slugKey) seenKeys.add(slugKey);
      if (nameKey) seenKeys.add(nameKey);
      addons.push(addon);
    }
  }
  return { version: version || undefined, source: sources.join(", "), addons };
}

export async function fetchMergedCatalog(catalogUrls: string[]) {
  const urls = parseCatalogUrlList(catalogUrls);
  const results = await Promise.all(urls.map(async (catalogUrl) => ({
    url: catalogUrl,
    catalog: await fetchCatalog(catalogUrl),
  })));
  const failedUrls = results.filter((result) => !result.catalog).map((result) => result.url);
  const catalog = mergeCatalogs(results.map((result) => result.catalog).filter(Boolean) as CatalogData[]);
  return { catalog, urls, failedUrls };
}

export function resolveAddonInstallSpec(addon: Pick<CatalogAddon, "name" | "version" | "install">): {
  kind: string;
  spec: string;
} {
  const explicitSpec = addon.install?.spec?.trim();
  if (explicitSpec) {
    return {
      kind: addon.install?.kind?.trim() || "tarball",
      spec: explicitSpec,
    };
  }
  return {
    kind: "package",
    spec: addon.name,
  };
}

export async function findCatalogAddon(slug: string, catalogUrls: string[]): Promise<CatalogAddon | null> {
  const { catalog } = await fetchMergedCatalog(catalogUrls);
  return catalog?.addons?.find((entry) => entry.slug === slug) ?? null;
}

function resolveInstallKind(addon: CatalogAddon): string {
  const kind = addon.install?.kind;
  return typeof kind === "string" && kind.trim() ? kind.trim() : "tarball";
}

async function readInstalledVersions(chatJid: string): Promise<Map<string, string>> {
  const { ensureSandbox } = await import("../sandbox/session.ts");
  const { chatJidToSessionId } = await import("../web-adapter.ts");
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) return new Map();
  const sandbox = await ensureSandbox(sessionId);
  const script = `
if [ ! -d /workspace/.pi/extensions/node_modules ]; then exit 0; fi
find /workspace/.pi/extensions/node_modules -mindepth 1 -maxdepth 3 -name package.json -print
`.trim();
  const result = await sandbox.commands.run(script, { timeoutMs: 30_000 });
  const versions = new Map<string, string>();
  for (const pkgJsonPath of result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    try {
      const raw = await sandbox.files.read(pkgJsonPath);
      const manifest = JSON.parse(String(raw)) as { name?: string; version?: string };
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        versions.set(manifest.name, manifest.version);
      }
    } catch {
      continue;
    }
  }
  return versions;
}

export async function getAddonsCatalog(chatJid: string, url?: URL) {
  const { catalog, urls, failedUrls } = await fetchMergedCatalog(resolveRequestedCatalogUrls(url));
  if (!catalog || !Array.isArray(catalog.addons)) {
    return { error: "Failed to fetch add-on catalog", status: 502 as const };
  }
  let installed = new Map<string, string>();
  try {
    installed = await readInstalledVersions(chatJid);
  } catch {
    installed = new Map();
  }
  const addons = catalog.addons.map((addon) => {
    const installedVersion = installed.get(addon.name) ?? null;
    const hasUpdate = Boolean(installedVersion && addon.version && installedVersion !== addon.version);
    return {
      slug: addon.slug,
      name: addon.name,
      version: addon.version || null,
      type: addon.type || "extension",
      description: addon.description || "",
      path: addon.path || "",
      homepage: addon.homepage || "",
      tags: addon.tags || [],
      skills: addon.skills || [],
      installed: Boolean(installedVersion),
      installedVersion,
      hasUpdate,
      installKind: resolveInstallKind(addon),
    };
  });
  return {
    status: 200 as const,
    body: { addons, source: catalog.source || "", sources: urls, failed_sources: failedUrls },
  };
}
