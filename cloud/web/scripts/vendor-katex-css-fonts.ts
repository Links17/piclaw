#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const PROJECT_DIR = process.cwd();

function resolveInstalledPath(packagePath: string): string {
  const candidates = [
    resolve(PROJECT_DIR, packagePath),
    resolve(PROJECT_DIR, "..", packagePath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const SOURCE_CSS = resolveInstalledPath("node_modules/katex/dist/katex.min.css");
const SOURCE_FONTS_DIR = resolveInstalledPath("node_modules/katex/dist/fonts");
const CSS_OUTPUT = resolve(PROJECT_DIR, "src/styles/katex.bundle.css");
const META_OUTPUT = resolve(PROJECT_DIR, "src/styles/katex.bundle.meta.json");
const FONTS_OUTPUT_DIR = resolve(PROJECT_DIR, "static/common/fonts");
const FONT_URL_PREFIX = "../../static/common/fonts";
const LOG_PREFIX = "[vendor:katex-css-fonts]";

interface KatexPackageJson {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
}

function sha256ForFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativePath(path: string): string {
  return relative(PROJECT_DIR, path);
}

function readKatexPackageJson(): KatexPackageJson {
  const packageJsonPath = resolveInstalledPath("node_modules/katex/package.json");
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as KatexPackageJson;
}

function packageRepositoryValue(packageJson: KatexPackageJson): string | null {
  if (typeof packageJson.repository === "string") return packageJson.repository;
  return packageJson.repository?.url || packageJson.homepage || null;
}

function listSourceFonts(): string[] {
  return readdirSync(SOURCE_FONTS_DIR)
    .filter((name) => name.endsWith(".woff2"))
    .sort((a, b) => a.localeCompare(b));
}

function removeStaleOutputFonts(expectedFiles: Set<string>): void {
  if (!existsSync(FONTS_OUTPUT_DIR)) return;
  for (const name of readdirSync(FONTS_OUTPUT_DIR)) {
    if (!name.startsWith("KaTeX_") || !name.endsWith(".woff2")) continue;
    if (expectedFiles.has(name)) continue;
    rmSync(resolve(FONTS_OUTPUT_DIR, name), { force: true });
  }
}

function rewriteKatexCss(sourceCss: string, fontFiles: string[]): { css: string; rewrittenCount: number } {
  const expectedFiles = new Set(fontFiles);
  let rewrittenCount = 0;

  const css = sourceCss.replace(
    /src:url\(fonts\/([^\)]+\.woff2)\) format\("woff2"\),url\(fonts\/[^\)]+\.woff\) format\("woff"\),url\(fonts\/[^\)]+\.ttf\) format\("truetype"\)/g,
    (_match, fontFile: string) => {
      if (!expectedFiles.has(fontFile)) {
        throw new Error(`Unexpected KaTeX font reference in CSS: ${fontFile}`);
      }
      rewrittenCount += 1;
      return `src:url(${FONT_URL_PREFIX}/${fontFile}) format("woff2")`;
    },
  );

  return { css, rewrittenCount };
}

function main(): void {
  if (!existsSync(SOURCE_CSS)) {
    throw new Error(`Missing source CSS: ${SOURCE_CSS}`);
  }
  if (!existsSync(SOURCE_FONTS_DIR)) {
    throw new Error(`Missing source font directory: ${SOURCE_FONTS_DIR}`);
  }

  const katexPackage = readKatexPackageJson();
  const fontFiles = listSourceFonts();
  if (fontFiles.length === 0) {
    throw new Error("No KaTeX .woff2 fonts found in node_modules/katex/dist/fonts");
  }

  mkdirSync(dirname(CSS_OUTPUT), { recursive: true });
  mkdirSync(dirname(META_OUTPUT), { recursive: true });
  mkdirSync(FONTS_OUTPUT_DIR, { recursive: true });

  const sourceCss = readFileSync(SOURCE_CSS, "utf8");
  const { css, rewrittenCount } = rewriteKatexCss(sourceCss, fontFiles);
  if (rewrittenCount !== fontFiles.length) {
    throw new Error(`Expected to rewrite ${fontFiles.length} KaTeX font declarations, got ${rewrittenCount}`);
  }
  if (css.includes("url(fonts/")) {
    throw new Error("KaTeX CSS still contains unresolved upstream font paths after rewrite");
  }
  if (css.includes('.woff) format("woff")') || css.includes('.ttf) format("truetype")')) {
    throw new Error("KaTeX CSS still contains non-woff2 font fallbacks after rewrite");
  }

  writeFileSync(CSS_OUTPUT, css, "utf8");

  const expectedFiles = new Set(fontFiles);
  removeStaleOutputFonts(expectedFiles);

  const outputFiles = [
    {
      package_path: "dist/katex.min.css",
      output_file: relativePath(CSS_OUTPUT),
      sha256: sha256ForFile(CSS_OUTPUT),
      size_bytes: statSync(CSS_OUTPUT).size,
      transform: "rewrite-font-urls-to-static-woff2-only",
    },
  ] as Array<Record<string, string | number>>;

  for (const fontFile of fontFiles) {
    const sourceFont = resolve(SOURCE_FONTS_DIR, fontFile);
    const outputFont = resolve(FONTS_OUTPUT_DIR, fontFile);
    copyFileSync(sourceFont, outputFont);
    outputFiles.push({
      package_path: `dist/fonts/${fontFile}`,
      output_file: relativePath(outputFont),
      sha256: sha256ForFile(outputFont),
      size_bytes: statSync(outputFont).size,
    });
  }

  const metadata = {
    manifest_id: "katex-css-fonts",
    workflow: "parallel-static-asset-workflow",
    workflow_reason:
      "KaTeX CSS/font assets are vendored via a dedicated static-asset script because the upstream CSS requires path rewriting and curated woff2-only font export rather than a straight JS bundle or raw file copy.",
    package_name: katexPackage.name || "katex",
    package_version: katexPackage.version || "unknown",
    package_license: katexPackage.license || "unknown",
    package_repository: packageRepositoryValue(katexPackage),
    source_css: relativePath(SOURCE_CSS),
    source_fonts_dir: relativePath(SOURCE_FONTS_DIR),
    output_file: outputFiles[0]?.output_file ?? null,
    output_files: outputFiles,
    metadata_file: relativePath(META_OUTPUT),
    sha256: outputFiles[0]?.sha256 ?? null,
    size_bytes: outputFiles[0]?.size_bytes ?? null,
    font_output_directory: relativePath(FONTS_OUTPUT_DIR),
    font_count: fontFiles.length,
    font_url_prefix: FONT_URL_PREFIX,
  };

  writeFileSync(META_OUTPUT, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  process.stdout.write([
    `${LOG_PREFIX} exported ${relativePath(CSS_OUTPUT)}`,
    ...fontFiles.map((fontFile) => `${LOG_PREFIX} exported ${relativePath(resolve(FONTS_OUTPUT_DIR, fontFile))}`),
    `${LOG_PREFIX} version ${metadata.package_version}`,
    `${LOG_PREFIX} metadata ${relativePath(META_OUTPUT)}`,
  ].join("\n"));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
