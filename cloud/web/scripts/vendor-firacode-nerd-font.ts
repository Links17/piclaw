#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WEB_ROOT = resolve(import.meta.dir, "..");

const RELEASE_VERSION = "v3.4.0";
const ZIP_NAME = "FiraCode.zip";
const RELEASE_URL = `https://github.com/ryanoasis/nerd-fonts/releases/download/${RELEASE_VERSION}/${ZIP_NAME}`;
const CACHE_DIR = resolve(REPO_ROOT, "generated", "cache", "vendor", "firacode-nerd-font", RELEASE_VERSION);
const ARCHIVE_PATH = resolve(CACHE_DIR, ZIP_NAME);
const OUTPUTS = [
  {
    archivePath: "FiraCodeNerdFontMono-Regular.ttf",
    outputFile: "static/common/fonts/vendor/firacode-nerd-font-mono-regular.ttf",
    weight: 400,
  },
  {
    archivePath: "FiraCodeNerdFontMono-Bold.ttf",
    outputFile: "static/common/fonts/vendor/firacode-nerd-font-mono-bold.ttf",
    weight: 700,
  },
] as const;
const METADATA_FILE = resolve(WEB_ROOT, "static/common/fonts/vendor/firacode-nerd-font.meta.json");

function sha256ForFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function ensureArchive(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (existsSync(ARCHIVE_PATH)) return;

  const response = await fetch(RELEASE_URL, {
    headers: {
      "User-Agent": "piclaw-vendor-workflow",
      "Accept": "application/octet-stream",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${RELEASE_URL}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(ARCHIVE_PATH, bytes);
}

function extractArchiveFile(archivePath: string, outputFile: string): void {
  mkdirSync(dirname(outputFile), { recursive: true });
  const proc = Bun.spawnSync(["unzip", "-p", ARCHIVE_PATH, archivePath], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `Failed to extract ${archivePath}`);
  }
  writeFileSync(outputFile, proc.stdout);
}

async function main(): Promise<void> {
  await ensureArchive();

  const outputs = OUTPUTS.map((entry) => {
    const outputPath = resolve(WEB_ROOT, entry.outputFile);
    extractArchiveFile(entry.archivePath, outputPath);
    return {
      archive_path: entry.archivePath,
      output_file: entry.outputFile,
      font_family: "FiraCode Nerd Font Mono",
      font_weight: entry.weight,
      sha256: sha256ForFile(outputPath),
      size_bytes: readFileSync(outputPath).byteLength,
    };
  });

  const metadata = {
    manifest_id: "firacode-nerd-font-mono",
    package_name: "nerd-fonts-release",
    package_version: RELEASE_VERSION,
    package_license: "MIT",
    package_repository: "https://github.com/ryanoasis/nerd-fonts",
    source_url: RELEASE_URL,
    archive_file: relative(REPO_ROOT, ARCHIVE_PATH),
    font_family: "FiraCode Nerd Font Mono",
    output_file: outputs[0]?.output_file ?? null,
    output_files: outputs,
    metadata_file: relative(REPO_ROOT, METADATA_FILE),
    sha256: outputs[0]?.sha256 ?? null,
    size_bytes: outputs[0]?.size_bytes ?? null,
  };

  mkdirSync(dirname(METADATA_FILE), { recursive: true });
  writeFileSync(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  process.stdout.write([
    ...outputs.map((output) => `[vendor:firacode-nerd-font-mono] exported ${output.output_file}`),
    `[vendor:firacode-nerd-font-mono] version ${RELEASE_VERSION}`,
    `[vendor:firacode-nerd-font-mono] metadata ${relative(REPO_ROOT, METADATA_FILE)}`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
