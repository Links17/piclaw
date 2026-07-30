#!/usr/bin/env bun
/**
 * situate.ts
 *
 * Self-orientation script. Reads daily notes, detects gaps and partial summaries
 * using timestamp watermarks in front matter, and prints a briefing.
 *
 * Flow:
 *   1. Run daily-notes.ts to generate/update skeletons
 *   2. Read daily notes; print their summaries
 *   3. For notes needing a summary: print that day's chat transcript
 *   4. For partial summaries: print only messages after summarised_until
 *   5. Append environment, preferences, scheduled tasks, skills
 *
 * For web chats, the transcript scope covers all web session trees so the
 * report captures activity across every root/branch conversation for the day.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { parseArgs } from "util";
import { execSync } from "child_process";
import {
  buildInClause,
  fallbackSessionScope,
  formatScopedChatLabel,
  resolveSessionScope,
  summariseSessionScope,
} from "./lib/chat-session-scope";
import { refreshAgentMemoryFromDailyNotes } from "./lib/agent-memory-sidecar";


// --help support
if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log("Usage: bun situate.ts [options]");
  console.log("");
  console.log("  situate.ts");
  process.exit(0);
}
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    days: { type: "string", default: "7" },
    out:  { type: "string", default: "/workspace/exports/situation.md" },
    db:   { type: "string",  default: `${process.env.PICLAW_STORE || "/workspace/.seeed/store"}/messages.db` },
    chat: { type: "string", default: "web:default" },
    "update-notes": { type: "boolean", default: false },
  },
  strict: true,
});

const DB_PATH   = args.db!;
const CHAT_JID  = args.chat!;
const OUT_PATH  = args.out!;
const DAYS      = parseInt(args.days!, 10);
const NOTES_DIR = "/workspace/notes/daily";
const SUMMARY_MARKER = "<!-- NEEDS_SUMMARY -->";
const SUMMARY_UPDATE_MARKER = "<!-- NEEDS_SUMMARY_UPDATE -->";
const UPDATE_NOTES = args["update-notes"]!;

// ── Helpers ─────────────────────────────────────────────────────────────
function run(cmd: string): string {
  try { return execSync(cmd, { timeout: 10000 }).toString().trim(); }
  catch { return "(unavailable)"; }
}
/** Read a file as UTF-8 text, returning empty string on failure. */
function readFile(path: string): string {
  try { return readFileSync(path, "utf-8").trim(); }
  catch { return ""; }
}
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function dayStartIso(day: string): string { return `${day}T00:00:00.000Z`; }
function nextDayStartIso(day: string): string {
  return new Date(new Date(dayStartIso(day)).getTime() + 86400000).toISOString();
}

/** Parsed YAML front matter: key-value fields and remaining body. */
interface FrontMatter {
  fields: Record<string, string>;
  body: string;
}

/** Parse YAML front matter from markdown content. */
function splitFrontMatter(content: string): FrontMatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fields: {}, body: content };
  const fmText = match[1];
  const body = content.slice(match[0].length);
  const fields: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    fields[key] = value;
  }
  return { fields, body };
}

/** Extract the ## Summary section text, ignoring placeholder markers. */
function extractSummary(body: string): string | null {
  const match = body.match(/## Summary\s*\n+([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  if (raw === SUMMARY_MARKER) return null;
  if (raw.startsWith(SUMMARY_MARKER)) {
    const cleaned = raw.replace(SUMMARY_MARKER, "").trim();
    return cleaned.length ? cleaned : null;
  }
  return raw;
}

/** Extract all ## Summary update sections as an array of strings. */
function extractSummaryUpdates(body: string): string[] {
  const updates: string[] = [];
  const re = /## Summary update.*?\n+([\s\S]*?)(?=^##\s|\s*$)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.includes(SUMMARY_UPDATE_MARKER)) continue;
    updates.push(raw);
  }
  return updates;
}

// ── 0. Generate/update daily note skeletons (on demand) ─────────────────
if (UPDATE_NOTES) {
  try {
    const cmd = [
      "bun run /workspace/scripts/daily-notes.ts",
      `--days ${DAYS}`,
      `--chat ${shellEscape(CHAT_JID)}`,
      `--db ${shellEscape(DB_PATH)}`,
    ].join(" ");
    execSync(cmd, { timeout: 30000 });
  } catch {
    // Daily note refresh is best-effort here.
  }
}

// ── 1. Read daily notes and classify ────────────────────────────────────
const cutoffDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
const noteFiles = readdirSync(NOTES_DIR)
  .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/) && f.slice(0, 10) >= cutoffDate)
  .sort();

/** Metadata for a daily note: day, path, summary, watermark, last message. */
interface NoteInfo {
  day: string;
  path: string;
  summary: string | null;
  watermark: string | null;
  lastMsg: string | null;
  dateField: string | null;
}

interface DayStatRow {
  day: string;
  last_ts: string;
  messages_total: number;
  session_trees: number;
  session_chats: number;
}

interface ScopeStatRow {
  root_chat_jid: string;
  messages_total: number;
  session_chats: number;
  first_ts: string;
  last_ts: string;
}

let sessionScope = fallbackSessionScope(CHAT_JID);
const dayStats = new Map<string, DayStatRow>();
const scopeStats: ScopeStatRow[] = [];

if (existsSync(DB_PATH)) {
  const db = new Database(DB_PATH, { readonly: true });
  sessionScope = resolveSessionScope(db, CHAT_JID);
  const scopeFilter = buildInClause("m.chat_jid", sessionScope.chats.map(chat => chat.chatJid));
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();
  const scopedParams = [...scopeFilter.params, cutoff];

  const dayRows = db.query<DayStatRow, any[]>(
    `SELECT substr(m.timestamp, 1, 10) AS day,
            MAX(m.timestamp) AS last_ts,
            COUNT(*) AS messages_total,
            COUNT(DISTINCT COALESCE(cb.root_chat_jid, m.chat_jid)) AS session_trees,
            COUNT(DISTINCT m.chat_jid) AS session_chats
     FROM messages m
     LEFT JOIN chat_branches cb ON cb.chat_jid = m.chat_jid
     WHERE ${scopeFilter.clause} AND m.timestamp >= ?
     GROUP BY day`
  ).all(...scopedParams);

  for (const row of dayRows) dayStats.set(row.day, row);

  scopeStats.push(...db.query<ScopeStatRow, any[]>(
    `SELECT COALESCE(cb.root_chat_jid, m.chat_jid) AS root_chat_jid,
            COUNT(*) AS messages_total,
            COUNT(DISTINCT m.chat_jid) AS session_chats,
            MIN(m.timestamp) AS first_ts,
            MAX(m.timestamp) AS last_ts
     FROM messages m
     LEFT JOIN chat_branches cb ON cb.chat_jid = m.chat_jid
     WHERE ${scopeFilter.clause} AND m.timestamp >= ?
     GROUP BY root_chat_jid
     ORDER BY last_ts DESC`
  ).all(...scopedParams));

  db.close();
}

const notes: NoteInfo[] = [];
for (const file of noteFiles) {
  const day = file.replace(".md", "");
  const path = `${NOTES_DIR}/${file}`;
  const content = readFile(path);
  const { fields, body } = splitFrontMatter(content);
  const summary = extractSummary(body);
  const updates = extractSummaryUpdates(body);
  const combined = [summary, ...updates].filter(Boolean).join("\n\n");
  notes.push({
    day,
    path,
    summary: combined || null,
    watermark: fields.summarised_until || null,
    lastMsg: dayStats.get(day)?.last_ts || null,
    dateField: fields.date || null,
  });
}

const summarised   = notes.filter(n => n.summary && n.watermark && n.lastMsg && n.lastMsg <= n.watermark);
const stale        = notes.filter(n => n.summary && n.watermark && n.lastMsg && n.lastMsg > n.watermark);
const unsummarised = notes.filter(n => !n.summary);
const missingWm    = notes.filter(n => n.summary && !n.watermark);
const dateMismatch = notes.filter(n => n.dateField && n.dateField !== n.day);

// ── 2. Extract chat for unsummarised/stale days ─────────────────────────
/** Row shape for queried messages. */
interface MsgRow {
  sender_name: string;
  is_bot_message: number;
  content: string;
  timestamp: string;
  chat_jid: string;
  root_chat_jid: string;
}

interface TreeMessageGroup {
  rootChatJid: string;
  messages: MsgRow[];
}

const scopeChatMap = new Map(sessionScope.chats.map(chat => [chat.chatJid, chat]));

function groupMessagesByTree(rows: MsgRow[]): TreeMessageGroup[] {
  const treeMap = new Map<string, MsgRow[]>();
  for (const row of rows) {
    if (!treeMap.has(row.root_chat_jid)) treeMap.set(row.root_chat_jid, []);
    treeMap.get(row.root_chat_jid)!.push(row);
  }

  return [...treeMap.entries()]
    .map(([rootChatJid, messages]) => ({ rootChatJid, messages }))
    .sort((a, b) => {
      const aFirst = a.messages[0]?.timestamp || "";
      const bFirst = b.messages[0]?.timestamp || "";
      if (aFirst !== bFirst) return aFirst.localeCompare(bFirst);
      return a.rootChatJid.localeCompare(b.rootChatJid);
    });
}

function formatMessagesByTree(rows: MsgRow[]): string[] {
  const groups = groupMessagesByTree(rows);
  const output: string[] = [];

  for (const group of groups) {
    const chatCount = new Set(group.messages.map(msg => msg.chat_jid)).size;
    output.push(`#### Tree ${group.rootChatJid}`);
    output.push("");
    output.push(`> ${group.messages.length} messages across ${chatCount} chat${chatCount === 1 ? "" : "s"}`);
    output.push("");

    for (const r of group.messages) {
      const content = (r.content || "").trim();
      if (!content) continue;
      const t = r.timestamp.slice(11, 16);
      const label = r.is_bot_message ? "assistant" : "user";
      const scopedChat = scopeChatMap.get(r.chat_jid);
      const chatLabel = scopedChat ? formatScopedChatLabel(scopedChat) : r.chat_jid;
      output.push(`- \`${t} ${label} | ${chatLabel}\` ${content.replace(/\n/g, " ").slice(0, 200)}`);
    }

    output.push("");
  }

  return output;
}

/** Query scoped chat messages for a given day, optionally after a watermark timestamp. */
function queryMessages(day: string, after?: string): string[] {
  if (!existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  const scopeFilter = buildInClause("m.chat_jid", sessionScope.chats.map(chat => chat.chatJid));
  const lowerBound = after || dayStartIso(day);
  const comparator = after ? ">" : ">=";
  const rows = db.query<MsgRow, any[]>(
    `SELECT m.sender_name,
            m.is_bot_message,
            m.content,
            m.timestamp,
            m.chat_jid,
            COALESCE(cb.root_chat_jid, m.chat_jid) AS root_chat_jid
     FROM messages m
     LEFT JOIN chat_branches cb ON cb.chat_jid = m.chat_jid
     WHERE ${scopeFilter.clause}
       AND m.timestamp ${comparator} ?
       AND m.timestamp < ?
     ORDER BY m.timestamp ASC`
  ).all(...scopeFilter.params, lowerBound, nextDayStartIso(day));
  db.close();

  return formatMessagesByTree(rows.filter(r => (r.content || "").trim().length > 0));
}

// ── 3. Environment ──────────────────────────────────────────────────────
const hostname = run("hostname");
const publicIp = run("curl -s --max-time 3 ifconfig.me");
const privateIp = run("hostname -I").split(" ")[0];
const uptime = run("uptime -p").replace("up ", "");
const os = run("grep PRETTY_NAME /etc/os-release").replace(/.*=\"?|\"$/g, "");
const kernel = run("uname -r");
const mem = run("free -h | awk '/Mem:/{print $2 \" total, \" $7 \" avail\"}'");
const disk = run("df -h / | awk 'NR==2{print $2 \" total, \" $4 \" free (\" $5 \" used)\"}'");
const vmSize = run("curl -sH 'Metadata:true' 'http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01&format=text' --max-time 3");
const location = run("curl -sH 'Metadata:true' 'http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text' --max-time 3");
const rg = run("curl -sH 'Metadata:true' 'http://169.254.169.254/metadata/instance/compute/resourceGroupName?api-version=2021-02-01&format=text' --max-time 3");
const subId = run("curl -sH 'Metadata:true' 'http://169.254.169.254/metadata/instance/compute/subscriptionId?api-version=2021-02-01&format=text' --max-time 3");

// ── 4. Preferences, notes index, tasks, skills ──────────────────────────
const prefs = readFile("/workspace/notes/preferences.md");
const index = readFile("/workspace/notes/index.md");

let scheduledTasks = "None active.";
if (existsSync(DB_PATH)) {
  const db = new Database(DB_PATH, { readonly: true });
  /** Row shape for active scheduled tasks query. */
  interface Task { id: string; schedule_value: string; prompt: string; }
  const tasks = db.query<Task, []>(
    `SELECT id, schedule_value, prompt FROM scheduled_tasks WHERE status = 'active' ORDER BY id`
  ).all();
  db.close();
  if (tasks.length > 0)
    scheduledTasks = tasks.map(t => `- **${t.id}** (${t.schedule_value}): ${t.prompt.slice(0, 100)}`).join("\n");
}

let skills = "(could not list)";
try {
  skills = execSync("ls /workspace/.pi/skills/", { timeout: 3000 })
    .toString().trim().split("\n").map(s => `\`${s}\``).join(", ");
} catch {
  // Skill listing is optional for this situational report.
}

const agentMemory = refreshAgentMemoryFromDailyNotes({ recentDays: Math.max(DAYS, 7) });
const agentMemoryCurrentStateRaw = readFile(agentMemory.currentStatePath);
const agentMemoryRecentContextRaw = readFile(agentMemory.recentContextPath);
let agentMemoryCurrentState: {
  complete_days?: Array<{ date: string }>;
  partial_days?: Array<{ date: string }>;
  unsummarised_days?: Array<{ date: string }>;
  latest_complete_date?: string | null;
  latest_complete_summary?: string | null;
} | null = null;
try {
  agentMemoryCurrentState = agentMemoryCurrentStateRaw ? JSON.parse(agentMemoryCurrentStateRaw) : null;
} catch {
  agentMemoryCurrentState = null;
}
const agentMemoryRecentContextBody = agentMemoryRecentContextRaw
  .replace(/^# Agent-ready recent context\s*/m, "")
  .trim();

// ── 5. Build output ─────────────────────────────────────────────────────
const now = new Date().toISOString().slice(0, 19) + "Z";
const sections: string[] = [];

sections.push(`# Situation Report\n> Generated: ${now}\n`);

sections.push("## Session Scope\n");
sections.push(`- Anchor chat: \`${CHAT_JID}\``);
sections.push(`- Mode: \`${sessionScope.mode}\``);
sections.push(`- Included scope: ${summariseSessionScope(sessionScope)}`);
if (scopeStats.length > 0) {
  for (const stat of scopeStats) {
    sections.push(`- Tree \`${stat.root_chat_jid}\` — ${stat.messages_total} messages across ${stat.session_chats} chats (${stat.first_ts.slice(0, 16).replace("T", " ")} → ${stat.last_ts.slice(0, 16).replace("T", " ")})`);
  }
}
sections.push("");

if (agentMemoryCurrentState || agentMemoryRecentContextBody) {
  sections.push("## Agent memory snapshot\n");
  if (agentMemoryCurrentState) {
    const completeCount = agentMemoryCurrentState.complete_days?.length || 0;
    const partialCount = agentMemoryCurrentState.partial_days?.length || 0;
    const unsummarisedCount = agentMemoryCurrentState.unsummarised_days?.length || 0;
    sections.push(`- Complete days in window: ${completeCount}`);
    sections.push(`- Partial days in window: ${partialCount}`);
    sections.push(`- Unsummarised days in window: ${unsummarisedCount}`);
    if (agentMemoryCurrentState.latest_complete_date) {
      sections.push(`- Latest complete day: ${agentMemoryCurrentState.latest_complete_date}`);
    }
    if (agentMemoryCurrentState.latest_complete_summary) {
      sections.push("");
      sections.push(`Latest complete summary:\n> ${agentMemoryCurrentState.latest_complete_summary}`);
    }
    sections.push("");
  }
  if (agentMemoryRecentContextBody) {
    sections.push("### Agent-ready recent context\n");
    sections.push(agentMemoryRecentContextBody);
    sections.push("");
  }
}

if (summarised.length > 0) {
  sections.push("## Recent Context\n");
  for (const n of summarised)
    sections.push(`### ${n.day}\n${n.summary}\n`);
}

if (stale.length > 0) {
  sections.push("## Partial Summaries\n");
  sections.push("Update the note with a Summary update block, then set summarised_until to the last message timestamp. New transcript material is linearised by session tree.\n");
  for (const n of stale) {
    const wmTime = n.watermark!.slice(11, 16);
    const lastTime = n.lastMsg!.slice(11, 16);
    const msgs = queryMessages(n.day, n.watermark!);
    const dayStat = dayStats.get(n.day);
    const scopeBits = dayStat ? ` — ${dayStat.messages_total} messages across ${dayStat.session_trees} trees / ${dayStat.session_chats} chats` : "";
    sections.push(`### ${n.day}${scopeBits} — new messages after ${wmTime} (last: ${lastTime})\n`);
    sections.push(`Current summary:\n> ${n.summary}\n`);
    if (msgs.length > 0) sections.push(`New messages:\n${msgs.join("\n")}\n`);
    sections.push(`File: \`${n.path}\`  \nSet front matter: \`summarised_until: ${n.lastMsg}\`\n`);
  }
}

if (missingWm.length > 0) {
  sections.push("## Missing Watermarks\n");
  for (const n of missingWm)
    sections.push(`- ${n.day}: ${n.path}`);
  sections.push("");
}

if (unsummarised.length > 0) {
  sections.push("## Unsummarised Days\n");
  sections.push("Write a terse summary and set summarised_until to the last message timestamp. Transcript previews below are linearised by session tree, with chat labels preserved inside each tree.\n");
  for (const n of unsummarised) {
    const msgs = queryMessages(n.day);
    const dayStat = dayStats.get(n.day);
    const scopeBits = dayStat ? `${dayStat.messages_total} messages across ${dayStat.session_trees} trees / ${dayStat.session_chats} chats` : `${msgs.length} messages`;
    sections.push(`### ${n.day} — ${scopeBits}\n`);
    if (msgs.length > 0) sections.push(`${msgs.join("\n")}\n`);
    sections.push(`File: \`${n.path}\`  \nLast message: \`${n.lastMsg}\`\n`);
  }
}

if (dateMismatch.length > 0) {
  sections.push("## Date Field Mismatches\n");
  for (const n of dateMismatch)
    sections.push(`- ${n.path} (front matter date ${n.dateField}, expected ${n.day})`);
  sections.push("");
}

sections.push(`## Environment
| | |
|---|---|
| Host | ${hostname} (${vmSize}, ${location}) |
| OS | ${os}, kernel ${kernel} |
| RG / Sub | ${rg} / ${subId.slice(0, 8)}… |
| IPs | ${privateIp} (private), ${publicIp} (public) |
| Uptime | ${uptime} |
| Disk | ${disk} |
| Memory | ${mem} |
`);
sections.push(`## User Preferences\n${prefs || "(none saved)"}\n`);
sections.push(`## Notes Index\n${index || "(empty)"}\n`);
sections.push(`## Scheduled Tasks\n${scheduledTasks}\n`);
sections.push(`## Agent Memory\n- Current state: \`${agentMemory.currentStatePath}\`\n- Recent context: \`${agentMemory.recentContextPath}\`\n`);
sections.push(`## Available Skills\n${skills}\n`);

const doc = sections.join("\n");
await Bun.write(OUT_PATH, doc);
console.log(doc);
console.error(`Wrote situation report to ${OUT_PATH}`);
