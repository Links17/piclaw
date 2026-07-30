#!/usr/bin/env bun
/**
 * scripts/backfill-token-usage.ts – Backfill token_usage from session JSON files.
 *
 * One-shot migration script that reads session conversation files from
 * the sessions directory, extracts token usage data from assistant messages,
 * and inserts them into the token_usage DB table. Safe to re-run (skips
 * existing entries).
 */

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import Database from "bun:sqlite";

const sessionsDir = process.env.PICLAW_SESSIONS_DIR || "/workspace/.seeed/data/sessions";
const storeDir = process.env.PICLAW_STORE || "/workspace/.seeed/store";
const dbPath = join(storeDir, "messages.db");

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    run_at TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_input REAL DEFAULT 0,
    cost_output REAL DEFAULT 0,
    cost_cache_read REAL DEFAULT 0,
    cost_cache_write REAL DEFAULT 0,
    cost_total REAL DEFAULT 0,
    model TEXT,
    provider TEXT,
    api TEXT,
    turns INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_chat_jid ON token_usage(chat_jid);
  CREATE INDEX IF NOT EXISTS idx_token_usage_run_at ON token_usage(run_at);
`);

const sanitizeJid = (jid: string) => jid.replace(/[^a-zA-Z0-9._-]/g, "_");

const jidMap = new Map<string, string>();
const chatsFile = "/workspace/.seeed/data/chats.json";
if (existsSync(chatsFile)) {
  try {
    const data = JSON.parse(readFileSync(chatsFile, "utf8"));
    const jids: string[] = Array.isArray(data?.jids) ? data.jids : [];
    for (const jid of jids) {
      jidMap.set(sanitizeJid(jid), jid);
    }
  } catch {
    // ignore
  }
}

const resolveChatJid = (dirName: string) => {
  if (jidMap.has(dirName)) return jidMap.get(dirName)!;
  if (dirName === "web_default") return "web:default";
  if (dirName.includes("_s.whatsapp.net")) return dirName.replace("_s.whatsapp.net", "@s.whatsapp.net");
  return dirName;
};

const selectExisting = db.prepare(
  `SELECT 1 FROM token_usage WHERE chat_jid = ? AND run_at = ? AND total_tokens = ? AND input_tokens = ? AND output_tokens = ? LIMIT 1`
);
const insertUsage = db.prepare(
  `INSERT INTO token_usage (
    chat_jid, run_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
    model, provider, api, turns
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let inserted = 0;
let skipped = 0;

const processFile = (filePath: string, chatJid: string) => {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || message.role !== "assistant" || !message.usage) continue;

    const usage = message.usage || {};
    const input = typeof usage.input === "number" ? usage.input : 0;
    const output = typeof usage.output === "number" ? usage.output : 0;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
    const totalTokens =
      (typeof usage.totalTokens === "number" && usage.totalTokens) ||
      (typeof usage.total === "number" && usage.total) ||
      input + output + cacheRead + cacheWrite;
    const cost = usage.cost || {};
    const costInput = typeof cost.input === "number" ? cost.input : 0;
    const costOutput = typeof cost.output === "number" ? cost.output : 0;
    const costCacheRead = typeof cost.cacheRead === "number" ? cost.cacheRead : 0;
    const costCacheWrite = typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0;
    const costTotal =
      (typeof cost.total === "number" && cost.total) ||
      costInput + costOutput + costCacheRead + costCacheWrite;

    const tsValue =
      typeof record.timestamp === "string" ? new Date(record.timestamp) :
      typeof message.timestamp === "number" ? new Date(message.timestamp) :
      new Date();
    const runAt = Number.isNaN(tsValue.getTime()) ? new Date().toISOString() : tsValue.toISOString();

    const exists = selectExisting.get(chatJid, runAt, totalTokens, input, output);
    if (exists) {
      skipped += 1;
      continue;
    }

    insertUsage.run(
      chatJid,
      runAt,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      costInput,
      costOutput,
      costCacheRead,
      costCacheWrite,
      costTotal,
      message.model ?? null,
      message.provider ?? null,
      message.api ?? null,
      1
    );
    inserted += 1;
  }
};

const walk = (dir: string, chatJid?: string) => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const resolvedJid = chatJid ?? resolveChatJid(entry);
      walk(full, resolvedJid);
    } else if (stat.isFile() && entry.endsWith(".jsonl")) {
      const jid = chatJid ?? "unknown";
      processFile(full, jid);
    }
  }
};

walk(sessionsDir);

console.log(`Backfill complete. Inserted ${inserted}, skipped ${skipped}.`);
