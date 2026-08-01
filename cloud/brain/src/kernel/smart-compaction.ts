import type { MessageRow } from "@piclaw-cloud/store";
import type { AgentMessage } from "./pi.ts";

export interface PersistedCompactionSummary {
  id: number;
  sessionId: string;
  compactedThroughMessageId: number;
  summary: string;
  tokensBefore: number;
  createdAt: string;
}

export interface CompactionWindow {
  rowsToSummarize: MessageRow[];
  retainedRows: MessageRow[];
  compactedThroughMessageId: number;
  overflow?: never;
}

export interface ContextOverflowWindow {
  rowsToSummarize: [];
  retainedRows: MessageRow[];
  compactedThroughMessageId: 0;
  overflow: {
    code: "context_overflow";
    budgetTokens: number;
    currentTurnTokens: number;
  };
}

export type CompactionSummaryStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export function validateCompactionSummary(options: {
  text: string;
  stopReason: CompactionSummaryStopReason;
  maxChars: number;
}): { valid: true } | { valid: false; reason: string } {
  const text = options.text.trim();
  if (options.stopReason !== "stop") {
    return { valid: false, reason: `stop_reason_${options.stopReason}` };
  }
  if (text.length === 0) return { valid: false, reason: "summary_empty" };
  if (text.length > options.maxChars) return { valid: false, reason: "summary_too_long" };
  const headings = text.match(/^##\s+\S.+$/gm) ?? [];
  if (headings.length < 2) return { valid: false, reason: "summary_structure_invalid" };
  return { valid: true };
}

function hasToolCalls(row: MessageRow): boolean {
  const blocks = row.content_blocks as { tool_calls?: unknown[] } | null;
  return row.role === "assistant" && Array.isArray(blocks?.tool_calls) && blocks.tool_calls.length > 0;
}

function toolCallIds(row: MessageRow): string[] {
  const blocks = row.content_blocks as {
    tool_calls?: Array<{ id?: unknown }>;
  } | null;
  if (!Array.isArray(blocks?.tool_calls)) return [];
  return blocks.tool_calls
    .map((call) => typeof call?.id === "string" ? call.id : "")
    .filter(Boolean);
}

function toolResultCallId(row: MessageRow): string | null {
  const blocks = row.content_blocks as { tool_call_id?: unknown } | null;
  return row.role === "tool" && typeof blocks?.tool_call_id === "string"
    ? blocks.tool_call_id
    : null;
}

function safeCutIndex(rows: MessageRow[], requested: number): number {
  let cut = Math.min(Math.max(1, requested), rows.length - 1);
  // Prefer compacting a complete human turn even when the fixed tail budget
  // lands between its user prompt and assistant response.
  if (rows[cut - 1]?.role === "user" && rows[cut]?.role === "assistant") {
    cut += 1;
    while (cut < rows.length && rows[cut]?.role === "tool") cut += 1;
    if (cut < rows.length && rows[cut]?.role === "assistant") cut += 1;
  }
  while (cut > 0) {
    const previous = rows[cut - 1];
    const next = rows[cut];
    if (next?.role === "tool") {
      cut -= 1;
      continue;
    }
    if (previous && hasToolCalls(previous)) {
      const callIds = new Set(toolCallIds(previous));
      const resultId = next ? toolResultCallId(next) : null;
      if (resultId && callIds.has(resultId)) {
        cut -= 1;
        continue;
      }
    }
    break;
  }
  return cut;
}

export function buildCompactionWindow(
  rows: MessageRow[],
  options:
    | { keepRecentMessages: number; afterMessageId?: number }
    | {
        contextWindow: number;
        reserveTokens: number;
        estimatedSummaryTokens: number;
        estimateRowTokens: (row: MessageRow) => number;
        afterMessageId?: number;
      },
): CompactionWindow | ContextOverflowWindow | null {
  const eligibleRows = options.afterMessageId == null
    ? rows
    : rows.filter((row) => row.id > options.afterMessageId!);
  if ("contextWindow" in options) {
    const budgetTokens = Math.max(
      0,
      Math.floor(options.contextWindow - options.reserveTokens - options.estimatedSummaryTokens),
    );
    let currentTurnStart = -1;
    for (let index = eligibleRows.length - 1; index >= 0; index -= 1) {
      if (eligibleRows[index]?.role === "user") {
        currentTurnStart = index;
        break;
      }
    }
    if (currentTurnStart < 0) return null;
    const currentTurnTokens = eligibleRows
      .slice(currentTurnStart)
      .reduce((total, row) => total + Math.max(0, options.estimateRowTokens(row)), 0);
    if (currentTurnTokens > budgetTokens) {
      return {
        rowsToSummarize: [],
        retainedRows: eligibleRows.slice(currentTurnStart),
        compactedThroughMessageId: 0,
        overflow: { code: "context_overflow", budgetTokens, currentTurnTokens },
      };
    }

    let retainedTokens = currentTurnTokens;
    let cut = currentTurnStart;
    while (cut > 0) {
      let previousTurnStart = cut - 1;
      while (previousTurnStart > 0 && eligibleRows[previousTurnStart]?.role !== "user") {
        previousTurnStart -= 1;
      }
      if (eligibleRows[previousTurnStart]?.role !== "user") break;
      const turnTokens = eligibleRows
        .slice(previousTurnStart, cut)
        .reduce((total, row) => total + Math.max(0, options.estimateRowTokens(row)), 0);
      if (retainedTokens + turnTokens > budgetTokens) break;
      retainedTokens += turnTokens;
      cut = previousTurnStart;
    }
    if (cut <= 0) return null;
    const rowsToSummarize = eligibleRows.slice(0, cut);
    const retainedRows = eligibleRows.slice(cut);
    const compactedThroughMessageId = rowsToSummarize.at(-1)?.id;
    if (compactedThroughMessageId == null) return null;
    return { rowsToSummarize, retainedRows, compactedThroughMessageId };
  }
  const keepRecentMessages = Math.max(1, options.keepRecentMessages);
  if (eligibleRows.length <= keepRecentMessages) return null;
  const requestedCut = eligibleRows.length - keepRecentMessages;
  let lastUserIndex = -1;
  for (let index = eligibleRows.length - 1; index >= 0; index -= 1) {
    if (eligibleRows[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex <= 0) return null;
  const cut = Math.min(safeCutIndex(eligibleRows, requestedCut), lastUserIndex);
  if (cut <= 0) return null;
  const rowsToSummarize = eligibleRows.slice(0, cut);
  const retainedRows = eligibleRows.slice(cut);
  const compactedThroughMessageId = rowsToSummarize.at(-1)?.id;
  if (compactedThroughMessageId == null) return null;
  return { rowsToSummarize, retainedRows, compactedThroughMessageId };
}

export function expandCompactionWindow(window: CompactionWindow): CompactionWindow | null {
  const nextUserIndex = window.retainedRows.findIndex((row) => row.role === "user");
  if (nextUserIndex < 0) return null;
  let followingUserIndex = -1;
  for (let index = nextUserIndex + 1; index < window.retainedRows.length; index += 1) {
    if (window.retainedRows[index]?.role === "user") {
      followingUserIndex = index;
      break;
    }
  }
  // The newest/current turn must always remain uncompressed.
  if (followingUserIndex < 0) return null;
  const movedRows = window.retainedRows.slice(0, followingUserIndex);
  const retainedRows = window.retainedRows.slice(followingUserIndex);
  const rowsToSummarize = [...window.rowsToSummarize, ...movedRows];
  const compactedThroughMessageId = rowsToSummarize.at(-1)?.id;
  if (
    compactedThroughMessageId == null
    || compactedThroughMessageId <= window.compactedThroughMessageId
  ) return null;
  return { rowsToSummarize, retainedRows, compactedThroughMessageId };
}

export function hydrateWithCompaction(
  rows: MessageRow[],
  summary: PersistedCompactionSummary | null,
): MessageRow[] {
  if (!summary) return rows;
  const retainedRows = rows.filter((row) => row.id > summary.compactedThroughMessageId);
  const summaryRow: MessageRow = {
    id: -summary.id,
    session_id: summary.sessionId,
    role: "system",
    content: summary.summary,
    content_blocks: {
      kind: "compaction_summary",
      tokens_before: summary.tokensBefore,
      compacted_through_message_id: summary.compactedThroughMessageId,
    },
    recovery_marker: false,
    created_at: summary.createdAt,
  };
  return [summaryRow, ...retainedRows];
}

export function compactionSummaryToAgentMessage(
  summary: PersistedCompactionSummary,
): AgentMessage {
  return {
    role: "compactionSummary",
    summary: summary.summary,
    tokensBefore: summary.tokensBefore,
    timestamp: Date.parse(summary.createdAt),
  };
}

export function compactToolResultText(
  text: string,
  options: { maxChars: number; edgeLines?: number },
): string {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return "";
  if (maxChars === 1) return "…";
  const lines = text.split("\n");
  const edgeLines = Math.max(1, options.edgeLines ?? 20);
  const omittedChars = Math.max(0, text.length - maxChars);
  const marker = `\n… ${omittedChars} characters omitted …\n`;
  const compactByCharacters = () => {
    if (marker.length >= maxChars) return `${text.slice(0, maxChars - 1)}…`;
    const available = maxChars - marker.length;
    const beginning = Math.ceil(available / 2);
    const ending = Math.floor(available / 2);
    return `${text.slice(0, beginning)}${marker}${ending > 0 ? text.slice(-ending) : ""}`;
  };
  if (lines.length <= edgeLines * 2) {
    return compactByCharacters();
  }
  const omitted = Math.max(0, lines.length - edgeLines * 2);
  const lineCompacted = [
    ...lines.slice(0, edgeLines),
    `… ${omitted} lines omitted by tool-result compaction …`,
    ...lines.slice(-edgeLines),
  ].join("\n");
  return lineCompacted.length <= maxChars ? lineCompacted : compactByCharacters();
}
