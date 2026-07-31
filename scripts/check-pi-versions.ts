#!/usr/bin/env bun
/**
 * Enforce pi dependency version alignment and kernel import boundaries.
 *
 * - All @earendil-works/* versions must match across package manifests.
 * - Outside agent-kernel/, direct imports of pi-agent-core or pi-ai main entry are forbidden.
 *   pi-ai subpaths and pi-coding-agent remain allowed in runtime/cloud.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const PACKAGE_MANIFESTS = [
  join(REPO_ROOT, "package.json"),
  join(REPO_ROOT, "agent-kernel", "package.json"),
  join(REPO_ROOT, "cloud", "package.json"),
] as const;

const SCAN_ROOTS = [
  join(REPO_ROOT, "runtime"),
  join(REPO_ROOT, "cloud"),
] as const;

const FORBIDDEN_IMPORTS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
] as const;

const ALLOWED_PI_AI_PREFIXES = [
  "@earendil-works/pi-ai/",
] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectPiVersions(): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();

  for (const manifestPath of PACKAGE_MANIFESTS) {
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing package manifest: ${manifestPath}`);
    }
    const pkg = readJson(manifestPath);
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field];
      if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const [name, specifier] of Object.entries(deps as Record<string, unknown>)) {
        if (!name.startsWith("@earendil-works/")) continue;
        if (typeof specifier !== "string") continue;
        const bucket = versions.get(name) ?? new Set<string>();
        bucket.add(specifier);
        versions.set(name, bucket);
      }
    }
  }

  return versions;
}

function walkFiles(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  const out: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git" || entry === "generated") continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
        out.push(full);
      }
    }
  };

  walk(baseDir);
  return out;
}

function extractModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const staticImportRegex = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportRegex = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const regex of [staticImportRegex, dynamicImportRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function isForbiddenPiImport(specifier: string): boolean {
  if (FORBIDDEN_IMPORTS.includes(specifier as (typeof FORBIDDEN_IMPORTS)[number])) {
    return true;
  }
  if (specifier.startsWith("@earendil-works/pi-ai/")) {
    return false;
  }
  return false;
}

function findImportViolations(): string[] {
  const violations: string[] = [];
  const agentKernelRoot = join(REPO_ROOT, "agent-kernel");

  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walkFiles(scanRoot)) {
      if (file.startsWith(agentKernelRoot)) continue;
      const rel = relative(REPO_ROOT, file);
      const specifiers = extractModuleSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (!isForbiddenPiImport(specifier)) continue;
        violations.push(`${rel}: forbidden direct pi import (${specifier}); use @piclaw/agent-kernel`);
      }
    }
  }

  return violations.sort();
}

function main(): void {
  let failed = false;

  const versions = collectPiVersions();
  for (const [name, specs] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (specs.size <= 1) continue;
    failed = true;
    console.error(`Version mismatch for ${name}: ${[...specs].sort().join(" vs ")}`);
  }

  const importViolations = findImportViolations();
  if (importViolations.length > 0) {
    failed = true;
    console.error("Kernel import boundary violations:");
    for (const violation of importViolations) {
      console.error(`- ${violation}`);
    }
  }

  if (failed) process.exit(1);

  const pinned = [...versions.entries()]
    .map(([name, specs]) => `${name}@${[...specs][0]}`)
    .sort()
    .join(", ");
  console.log(`Pi dependency alignment ok (${pinned}). Kernel import boundaries ok.`);
}

main();
