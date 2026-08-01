import type { Sandbox } from "../sandbox/client.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { readFile, writeFile } from "../sandbox/fs.ts";
import { chatJidToSessionId } from "../web-adapter.ts";
import {
  findCatalogAddon,
  resolveAddonInstallSpec,
  resolveRequestedCatalogUrls,
  type CatalogAddon,
} from "./catalog.ts";

const ADDONS_DIR = "/workspace/.pi/extensions";
const ADDONS_NODE_MODULES = `${ADDONS_DIR}/node_modules`;
const ADDONS_PACKAGE_JSON = `${ADDONS_DIR}/package.json`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runSandboxScript(
  sandbox: Sandbox,
  script: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.commands.run(script, { timeoutMs });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.exitCode,
  };
}

async function ensureAddonsLayout(sandbox: Sandbox): Promise<void> {
  const script = `
set -e
mkdir -p ${shellQuote(ADDONS_NODE_MODULES)}
if [ ! -f ${shellQuote(ADDONS_PACKAGE_JSON)} ]; then
  printf '%s\\n' '{"name":"piclaw-local-addons","private":true,"dependencies":{}}' > ${shellQuote(ADDONS_PACKAGE_JSON)}
fi
if [ -L ${shellQuote(ADDONS_NODE_MODULES)} ]; then
  rm ${shellQuote(ADDONS_NODE_MODULES)}
  mkdir -p ${shellQuote(ADDONS_NODE_MODULES)}
fi
`.trim();
  const result = await runSandboxScript(sandbox, script);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Failed to prepare add-ons directory");
  }
}

async function readInstalledVersion(sandbox: Sandbox, packageName: string): Promise<string | null> {
  const pkgPath = `${ADDONS_NODE_MODULES}/${packageName}/package.json`;
  try {
    const manifest = JSON.parse(await readFile(sandbox, pkgPath)) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function setAddonDependencyRecord(
  sandbox: Sandbox,
  packageName: string,
  spec: string,
): Promise<void> {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(sandbox, ADDONS_PACKAGE_JSON)) as { dependencies?: Record<string, string> };
  } catch {
    pkg = { dependencies: {} };
  }
  if (!pkg.dependencies) pkg.dependencies = {};
  pkg.dependencies[packageName] = spec;
  await writeFile(sandbox, ADDONS_PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function removeAddonDependencyRecord(sandbox: Sandbox, packageName: string): Promise<void> {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(sandbox, ADDONS_PACKAGE_JSON)) as { dependencies?: Record<string, string> };
  } catch {
    return;
  }
  if (!pkg.dependencies || !(packageName in pkg.dependencies)) return;
  delete pkg.dependencies[packageName];
  await writeFile(sandbox, ADDONS_PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function installAddonFromTarball(
  sandbox: Sandbox,
  addon: CatalogAddon,
  installPlan: { kind: string; spec: string },
): Promise<{ installedVersion: string | null }> {
  const destDir = `${ADDONS_NODE_MODULES}/${addon.name}`;
  const stagingRoot = `${ADDONS_DIR}/.staging`;
  const stagingLeaf = `${addon.name.replace(/[\\/]+/g, "__")}-${Date.now()}`;
  const stagingDir = `${stagingRoot}/${stagingLeaf}`;
  const archivePath = `${stagingRoot}/${stagingLeaf}.tgz`;

  const script = `
set -e
mkdir -p ${shellQuote(stagingDir)}
curl -fsSL ${shellQuote(installPlan.spec)} -o ${shellQuote(archivePath)}
tar xzf ${shellQuote(archivePath)} -C ${shellQuote(stagingDir)}
ROOT=${shellQuote(stagingDir)}
if [ ! -f "$ROOT/package.json" ]; then
  if [ -f "$ROOT/package/package.json" ]; then
    ROOT="$ROOT/package"
  else
    for d in "$ROOT"/*; do
      if [ -d "$d" ] && [ -f "$d/package.json" ]; then ROOT="$d"; break; fi
    done
  fi
fi
test -f "$ROOT/package.json"
NAME=$(node -p "require(process.argv[1]).name" "$ROOT/package.json")
test "$NAME" = ${shellQuote(addon.name)}
rm -rf ${shellQuote(destDir)}
mkdir -p ${shellQuote(ADDONS_NODE_MODULES)}
mv "$ROOT" ${shellQuote(destDir)}
if [ -f ${shellQuote(destDir)}/package.json ] && node -e "const p=require(process.argv[1]); process.exit(p.dependencies && Object.keys(p.dependencies).length ? 0 : 1)" ${shellQuote(destDir)}/package.json; then
  (cd ${shellQuote(destDir)} && bun install --force)
fi
rm -f ${shellQuote(archivePath)}
rm -rf ${shellQuote(stagingDir)}
`.trim();

  const result = await runSandboxScript(sandbox, script, 180_000);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Tarball install failed");
  }

  await setAddonDependencyRecord(sandbox, addon.name, installPlan.spec);
  return { installedVersion: await readInstalledVersion(sandbox, addon.name) };
}

async function installAddonFromPackageSpec(
  sandbox: Sandbox,
  addon: CatalogAddon,
  installPlan: { kind: string; spec: string },
): Promise<{ installedVersion: string | null }> {
  const script = `
set -e
cd ${shellQuote(ADDONS_DIR)}
bun add --force ${shellQuote(installPlan.spec)}
`.trim();
  const result = await runSandboxScript(sandbox, script, 180_000);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Package install failed");
  }
  return { installedVersion: await readInstalledVersion(sandbox, addon.name) };
}

export async function installAddonForChat(
  chatJid: string,
  slug: string,
  url?: URL,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) {
    return { status: 400, body: { error: "chat_jid required" } };
  }

  const catalogUrls = resolveRequestedCatalogUrls(url);
  const addon = await findCatalogAddon(slug, catalogUrls);
  if (!addon) {
    return { status: 404, body: { error: `Add-on "${slug}" not found in catalog` } };
  }

  const sandbox = await ensureSandbox(sessionId);
  await ensureAddonsLayout(sandbox);
  const installPlan = resolveAddonInstallSpec(addon);
  const installPlanIsTarballUrl = installPlan.kind === "tarball" && /^https?:\/\//.test(installPlan.spec);

  try {
    const installed = installPlanIsTarballUrl
      ? await installAddonFromTarball(sandbox, addon, installPlan)
      : installPlan.kind === "direct-download"
        ? null
        : await installAddonFromPackageSpec(sandbox, addon, installPlan);

    if (!installed) {
      return {
        status: 400,
        body: { error: "Catalog add-on installs must provide a tarball URL or package spec." },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        slug,
        name: addon.name,
        installedVersion: installed.installedVersion,
        installKind: installPlan.kind,
        installSpec: installPlan.spec,
        message: `Installed ${addon.name}@${installed.installedVersion || addon.version || "?"}. Refresh the page to load add-on UI entries.`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { error: `Install failed: ${message}` } };
  }
}

export async function uninstallAddonForChat(
  chatJid: string,
  slug: string,
  url?: URL,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) {
    return { status: 400, body: { error: "chat_jid required" } };
  }

  const catalogUrls = resolveRequestedCatalogUrls(url);
  const addon = await findCatalogAddon(slug, catalogUrls);
  if (!addon) {
    return { status: 404, body: { error: `Add-on "${slug}" not found in catalog` } };
  }

  const sandbox = await ensureSandbox(sessionId);
  await ensureAddonsLayout(sandbox);
  const destDir = `${ADDONS_NODE_MODULES}/${addon.name}`;

  const script = `
set -e
cd ${shellQuote(ADDONS_DIR)}
if bun remove ${shellQuote(addon.name)}; then
  exit 0
fi
rm -rf ${shellQuote(destDir)}
`.trim();

  const result = await runSandboxScript(sandbox, script, 120_000);
  if (!result.ok) {
    return {
      status: 500,
      body: { error: `Uninstall failed: ${result.stderr || result.stdout || "unknown error"}` },
    };
  }

  await removeAddonDependencyRecord(sandbox, addon.name);
  return {
    status: 200,
    body: {
      ok: true,
      slug,
      name: addon.name,
      message: `Removed ${addon.name}. Refresh the page to unload add-on UI entries.`,
    },
  };
}

export function restartAddonRuntimeResponse(): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      ok: true,
      message: "Add-on changes are live in the workspace sandbox. Refresh the page to reload add-on UI entries.",
    },
  };
}
