#!/usr/bin/env bun
/**
 * migrate-legacy-inline-tool-results.ts
 *
 * Optional one-time migration utility:
 * - scans persisted session JSONL files
 * - finds oversized inline toolResult text payloads
 * - externalizes them to tool-output handles
 * - rewrites session entries to compact text + stored-output metadata
 *
 * Dry-run by default. Pass --write to persist changes.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { initDatabase } from "../runtime/src/db.js";
import { buildPreview, saveToolOutput } from "../runtime/src/tool-output.js";

type JsonRecord = Record<string, unknown>;

const COMPACTION_EXCLUDED_TOOL_NAMES = new Set(["read"]);

type Stats = {
  scannedFiles: number;
  scannedLines: number;
  parseErrors: number;
  candidateEntries: number;
  changedEntries: number;
  changedFiles: number;
  rewrittenFiles: number;
  bytesBefore: number;
  bytesAfter: number;
};

const args = process.argv.slice(2);

function readArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function readIntArg(name: string, fallback: number): number {
  const raw = readArg(name);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type !== "text") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function hasImageOrBinaryBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "image") return true;
    return block.type !== "text" && typeof block.data === "string" && block.data.length > 0;
  });
}

function hasStoredOutputMarker(text: string): boolean {
  if (!text) return false;
  return /tool-output:[A-Za-z0-9_-]+/.test(text)
    || /Use search_tool_output with handle\s+"[A-Za-z0-9_-]+"/.test(text);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

function resolveToolName(message: JsonRecord): string {
  const candidates = [message.toolName, message.tool_name, message.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "unknown";
}

function resolveSource(toolName: string): string {
  return `migration:${toolName || "unknown"}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shouldCompact(text: string, toolName: string, thresholdsByTool: Record<string, { bytes: number; lines: number }>, defaultBytes: number, defaultLines: number): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (COMPACTION_EXCLUDED_TOOL_NAMES.has(normalizedToolName)) return false;
  const policy = thresholdsByTool[normalizedToolName];
  const bytesThreshold = Number.isFinite(policy?.bytes) ? policy.bytes : defaultBytes;
  const linesThreshold = Number.isFinite(policy?.lines) ? policy.lines : defaultLines;
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > bytesThreshold || lineCount(text) > linesThreshold;
}

function parseThresholdsByTool(raw: string | undefined): Record<string, { bytes: number; lines: number }> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, { bytes: number; lines: number }> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const bytes = Number(value.bytes);
      const lines = Number(value.lines);
      out[key.trim().toLowerCase()] = {
        bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : Number.NaN,
        lines: Number.isFinite(lines) && lines > 0 ? Math.round(lines) : Number.NaN,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function makeDigest(source: string, text: string): string {
  const hash = createHash("sha1");
  hash.update(source);
  hash.update("\0");
  hash.update(text);
  return hash.digest("hex");
}

const sessionsDir = resolve(readArg("--sessions-dir") || "/workspace/.seeed/data/sessions");
const chatFilter = readArg("--chat")?.trim();
const maxFiles = readIntArg("--max-files", Number.MAX_SAFE_INTEGER);
const previewLines = readIntArg("--preview-lines", 8);
const previewLineChars = readIntArg("--preview-line-chars", 200);
const defaultStoreBytes = readIntArg("--store-bytes", Number.parseInt(process.env.PICLAW_TOOL_OUTPUT_STORE_BYTES || "4096", 10));
const defaultStoreLines = readIntArg("--store-lines", Number.parseInt(process.env.PICLAW_TOOL_OUTPUT_STORE_LINES || "40", 10));
const writeMode = hasFlag("--write");
const dryRun = !writeMode;
const verbose = hasFlag("--verbose");
const thresholdsByTool = parseThresholdsByTool(readArg("--thresholds-by-tool") || process.env.PICLAW_TOOL_OUTPUT_STORE_THRESHOLDS_BY_TOOL);

const stats: Stats = {
  scannedFiles: 0,
  scannedLines: 0,
  parseErrors: 0,
  candidateEntries: 0,
  changedEntries: 0,
  changedFiles: 0,
  rewrittenFiles: 0,
  bytesBefore: 0,
  bytesAfter: 0,
};

const touchedFiles: string[] = [];
const savedByDigest = new Map<string, ReturnType<typeof saveToolOutput>>();

if (!dryRun) {
  initDatabase();
}

function maybeCompactMessage(message: JsonRecord): JsonRecord | null {
  const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
  if (role !== "toolresult" && role !== "tool_result") return null;

  const content = message.content;
  if (!Array.isArray(content) || hasImageOrBinaryBlocks(content)) return null;

  const text = extractText(content);
  if (!text.trim()) return null;
  if (hasStoredOutputMarker(text)) return null;

  const toolName = resolveToolName(message);
  if (!shouldCompact(text, toolName, thresholdsByTool, defaultStoreBytes, defaultStoreLines)) return null;

  stats.candidateEntries += 1;

  if (dryRun) {
    stats.changedEntries += 1;
    stats.bytesBefore += Buffer.byteLength(text, "utf8");
    const preview = buildPreview(text, previewLines, previewLineChars);
    const drySummary = [
      `Output stored as tool-output:out_dry_run (${lineCount(text)} lines, ${formatBytes(Buffer.byteLength(text, "utf8"))}).`,
      preview ? `Preview:\n${preview}` : null,
      `Use search_tool_output with handle "out_dry_run" and a query to retrieve relevant snippets.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    stats.bytesAfter += Buffer.byteLength(drySummary, "utf8");
    return { ...message };
  }

  const source = resolveSource(toolName);
  const digest = makeDigest(source, text);
  let saved = savedByDigest.get(digest);
  if (!saved) {
    const preview = buildPreview(text, previewLines, previewLineChars);
    saved = saveToolOutput(text, { source, summary: preview });
    savedByDigest.set(digest, saved);
  }

  const summaryText = [
    `Output stored as tool-output:${saved.id} (${saved.lineCount} lines, ${formatBytes(saved.sizeBytes)}).`,
    saved.summary ? `Preview:\n${saved.summary}` : null,
    `Use search_tool_output with handle "${saved.id}" and a query to retrieve relevant snippets.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const details = isRecord(message.details) ? { ...message.details } : {};
  details.storedOutputId = saved.id;
  details.storedOutputPath = saved.path;
  details.storedOutputLines = saved.lineCount;
  details.storedOutputBytes = saved.sizeBytes;
  details.storedOutputSource = source;

  stats.changedEntries += 1;
  stats.bytesBefore += Buffer.byteLength(text, "utf8");
  stats.bytesAfter += Buffer.byteLength(summaryText, "utf8");

  return {
    ...message,
    content: [{ type: "text", text: summaryText }],
    details,
  };
}

function processSessionFile(filePath: string): void {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\n/);
  const outputLines = dryRun ? null : [...lines];

  let changedInFile = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    stats.scannedLines += 1;
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stats.parseErrors += 1;
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type !== "message") continue;

    const message = isRecord(parsed.message) ? parsed.message : null;
    if (!message) continue;

    const migratedMessage = maybeCompactMessage(message);
    if (!migratedMessage) continue;

    changedInFile = true;
    if (!dryRun && outputLines) {
      const nextEntry = { ...parsed, message: migratedMessage };
      outputLines[i] = JSON.stringify(nextEntry);
    }
  }

  if (!changedInFile) return;

  stats.changedFiles += 1;
  touchedFiles.push(filePath);

  if (dryRun || !outputLines) return;

  const tempDir = mkdtempSync(join(tmpdir(), "piclaw-tool-result-migrate-"));
  const tempPath = join(tempDir, "rewritten.jsonl");
  try {
    writeFileSync(tempPath, outputLines.join("\n"), "utf8");
    renameSync(tempPath, filePath);
    stats.rewrittenFiles += 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function walkSessions(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (chatFilter && entry.name !== chatFilter) continue;
      walkSessions(fullPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (stats.scannedFiles >= maxFiles) return;

    stats.scannedFiles += 1;
    processSessionFile(fullPath);
  }
}

if (!statSync(sessionsDir).isDirectory()) {
  throw new Error(`Sessions directory is not a directory: ${sessionsDir}`);
}

walkSessions(sessionsDir);

console.log(`Mode: ${dryRun ? "dry-run" : "write"}`);
console.log(`Sessions root: ${sessionsDir}`);
if (chatFilter) console.log(`Chat filter: ${chatFilter}`);
console.log(`Thresholds: bytes>${defaultStoreBytes} OR lines>${defaultStoreLines}`);
if (Object.keys(thresholdsByTool).length > 0) {
  console.log(`Per-tool thresholds: ${JSON.stringify(thresholdsByTool)}`);
}
console.log(`Scanned files: ${stats.scannedFiles}`);
console.log(`Scanned lines: ${stats.scannedLines}`);
console.log(`Parse errors: ${stats.parseErrors}`);
console.log(`Candidate entries: ${stats.candidateEntries}`);
console.log(`Changed entries: ${stats.changedEntries}`);
console.log(`Changed files: ${stats.changedFiles}`);
console.log(`Rewritten files: ${stats.rewrittenFiles}`);
console.log(`Estimated bytes before: ${formatBytes(stats.bytesBefore)}`);
console.log(`Estimated bytes after: ${formatBytes(stats.bytesAfter)}`);
if (stats.bytesBefore > 0) {
  const reduction = ((stats.bytesBefore - stats.bytesAfter) / stats.bytesBefore) * 100;
  console.log(`Estimated reduction: ${formatBytes(stats.bytesBefore - stats.bytesAfter)} (${reduction.toFixed(1)}%)`);
}

if (verbose && touchedFiles.length > 0) {
  console.log("Touched files:");
  for (const file of touchedFiles) {
    console.log(`- ${relative(process.cwd(), file)}`);
  }
}
