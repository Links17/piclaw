import * as store from "@piclaw-cloud/store";
import type { MessageRow } from "@piclaw-cloud/store";
import { ensureSandbox } from "../sandbox/session.ts";
import { writeFile } from "../sandbox/fs.ts";
import { WORKSPACE_ROOT } from "../tools/path.ts";
import {
  AUTO_DREAM_DEFAULT_DAYS,
  MANUAL_DREAM_DEFAULT_DAYS,
  parseDreamPromptToken,
} from "./constants.ts";

const DREAM_DAILY_DIR = `${WORKSPACE_ROOT}/notes/daily`;
const DREAM_MEMORY_DIR = `${WORKSPACE_ROOT}/notes/memory`;
const DREAM_MEMORY_PATH = `${DREAM_MEMORY_DIR}/MEMORY.md`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function countRecentUserMessages(sessionId: string, days: number): Promise<number> {
  const rows = await store.listMessages(sessionId, 500);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return rows.filter((row) => row.role === "user" && new Date(row.created_at).getTime() >= cutoff).length;
}

function formatDailyNote(sessionId: string, day: string, messages: MessageRow[]): string {
  const lines = [`# Daily note — ${day}`, "", `Session: ${sessionId}`, ""];
  for (const row of messages) {
    const stamp = new Date(row.created_at).toISOString();
    lines.push(`## ${row.role} @ ${stamp}`, "", row.content.trim(), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export async function runCloudDreamMaintenance(options: {
  sessionId: string;
  prompt: string;
  mode?: "manual" | "auto";
  signal?: AbortSignal;
}): Promise<{ skipped: boolean; summary: string }> {
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("dream maintenance aborted");
  };
  throwIfAborted();
  const token = parseDreamPromptToken(options.prompt);
  if (!token.matched) {
    return { skipped: true, summary: `Unknown internal task: ${options.prompt || "(empty)"}` };
  }
  const mode = options.mode ?? token.mode;
  const days = token.days || (mode === "auto" ? AUTO_DREAM_DEFAULT_DAYS : MANUAL_DREAM_DEFAULT_DAYS);

  const recentCount = await countRecentUserMessages(options.sessionId, days);
  throwIfAborted();
  if (mode === "auto" && recentCount === 0) {
    return { skipped: true, summary: "AutoDream skipped: no recent user messages." };
  }

  const sbx = await ensureSandbox(options.sessionId);
  throwIfAborted();
  await sbx.commands.run(`mkdir -p ${shellQuote(DREAM_DAILY_DIR)} ${shellQuote(DREAM_MEMORY_DIR)}`);

  const rows = await store.listMessages(options.sessionId, 500);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const byDay = new Map<string, MessageRow[]>();
  for (const row of rows) {
    if (new Date(row.created_at).getTime() < cutoff) continue;
    const day = dateKey(new Date(row.created_at));
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }

  let completeDays = 0;
  for (const [day, messages] of byDay.entries()) {
    throwIfAborted();
    if (messages.length === 0) continue;
    const notePath = `${DREAM_DAILY_DIR}/${day}.md`;
    await writeFile(sbx, notePath, formatDailyNote(options.sessionId, day, messages));
    completeDays += 1;
  }

  const memorySummary = [
    "# MEMORY",
    "",
    `Last consolidated: ${new Date().toISOString()}`,
    `Mode: ${mode}`,
    `Days scanned: ${days}`,
    `Daily notes written: ${completeDays}`,
    `Recent user messages: ${recentCount}`,
    "",
    "This file is maintained by the cloud Dream maintenance job.",
    "",
  ].join("\n");
  await writeFile(sbx, DREAM_MEMORY_PATH, memorySummary);
  throwIfAborted();

  return {
    skipped: false,
    summary: `${mode === "auto" ? "AutoDream" : "Dream"} updated ${DREAM_MEMORY_PATH} (${completeDays} daily note${completeDays === 1 ? "" : "s"}).`,
  };
}
