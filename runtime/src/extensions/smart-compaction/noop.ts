/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import type { FileOperations, CompactionResult } from "@earendil-works/pi-coding-agent";
import type { Message } from "@piclaw/agent-kernel";
import { createLogger } from "../../utils/logger.js";
import { MIN_SUMMARY_CHARS } from "./config.js";
import { compressFilePaths, fileListsFromOps } from "./files.js";
import {
  extractText,
  isRealUserMessage,
  type ToolOutcomeAnalysis,
} from "./messages.js";
import type { TopicShiftSignal } from "./selective-prompt.js";

const log = createLogger("ext.smart-compaction.noop");

// ---------------------------------------------------------------------------

const HARMLESS_ACKNOWLEDGEMENTS = new Set([
  "got it",
  "noted",
  "thank you",
  "thanks",
  "thx",
  "understood",
]);

function isHarmlessAcknowledgement(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");
  return HARMLESS_ACKNOWLEDGEMENTS.has(normalized);
}

/**
 * Detect compaction windows where an LLM call is unnecessary.
 *
 * Two patterns are detected:
 *
 * 1. **Split-turn continuation** — The compaction window contains zero user
 *    messages (the agent was executing a long tool-call sequence that hit the
 *    token limit mid-turn). The previous summary already describes the goal
 *    and progress; we just append a mechanical file-ops delta.
 *
 * 2. **Harmless acknowledgement** — Every real user message is an exact match
 *    for a narrow acknowledgement allowlist, there are no file modifications,
 *    and no tool outcome carries new state. Shortness alone is never sufficient:
 *    constraints, negations, paths, commands, numbers, and topic signals fall
 *    through to summarization by default.
 *
 * Returns a `{ compaction }` result to short-circuit the LLM path, or
 * `null` to fall through to the selected smart-compaction method.
 */
export function tryNoOpCompaction(
  llmMessages: Message[],
  preparation: {
    previousSummary?: string;
    fileOps: FileOperations;
    isSplitTurn?: boolean;
    customInstructions?: string;
  },
  firstKeptEntryId: string,
  tokensBefore: number,
  topicShift: TopicShiftSignal | null,
  humanUserIndexes: Set<number>,
  toolAnalysis: ToolOutcomeAnalysis,
  currentWorkHints: {
    hasKeptUserContext: boolean;
    hasTurnPrefixHumanUser: boolean;
  },
  publishStatus?: (message: string, completionPercent: number) => void,
): { compaction: CompactionResult } | null {
  const { previousSummary, fileOps } = preparation;
  if (preparation.customInstructions?.trim()) {
    log.debug("Smart compaction no-op rejected", {
      operation: "smart_compaction.noop_classification",
      classification: "summarize",
      reason: "custom_instructions_present",
    });
    return null;
  }

  // We can only do no-op if there IS a previous summary to reuse
  if (!previousSummary || previousSummary.length < MIN_SUMMARY_CHARS) {
    log.debug("Smart compaction no-op rejected", {
      operation: "smart_compaction.noop_classification",
      classification: "summarize",
      reason: "missing_or_short_previous_summary",
    });
    return null;
  }

  // Count real user messages (non-slash-command, non-synthetic)
  let userMessageCount = 0;
  let userTotalChars = 0;
  const userTexts: string[] = [];
  for (let i = 0; i < llmMessages.length; i++) {
    const msg = llmMessages[i];
    if (isRealUserMessage(msg, i, humanUserIndexes)) {
      const text = extractText(msg.content);
      userMessageCount++;
      userTotalChars += text.length;
      userTexts.push(text);
    }
  }

  const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);
  const hasModifications = modifiedFiles.length > 0;
  // topicShift and toolAnalysis are pre-computed by the caller.

  // ── Pattern 1: Split-turn continuation ────────────────────────────
  // Zero user messages in the discarded window can still be unsafe if the
  // dropped prefix of the current turn contains a fresh user instruction.
  if (
    preparation.isSplitTurn
    && userMessageCount === 0
    && !currentWorkHints.hasTurnPrefixHumanUser
    && toolAnalysis.safeForNoOp
  ) {
    const delta = buildMechanicalDelta(llmMessages, modifiedFiles, readFiles, toolAnalysis);
    const summary = appendDeltaToSummary(previousSummary, delta, fileOps);

    publishStatus?.(
      `Smart compaction: reused summary for split-turn continuation (${llmMessages.length} tool msgs)…`,
      92,
    );

    log.debug("Smart compaction no-op accepted", {
      operation: "smart_compaction.noop_classification",
      classification: "split_turn_continuation",
      userMessageCount,
      messageCount: llmMessages.length,
      toolOutcomeCount: toolAnalysis.facts.length,
    });
    return {
      compaction: { summary, firstKeptEntryId, tokensBefore },
    };
  }

  // ── Pattern 2: Harmless acknowledgement ──────────────────────────
  // Exact allowlisting keeps short constraints such as "don't deploy" and
  // "use Bun" out of the lossy path. Any tool result with new state also
  // requires summarization even when the user text itself is harmless.
  if (
    userMessageCount > 0 &&
    userTexts.every(isHarmlessAcknowledgement) &&
    !hasModifications &&
    !topicShift &&
    toolAnalysis.safeForNoOp &&
    toolAnalysis.facts.length === 0 &&
    !currentWorkHints.hasKeptUserContext &&
    !currentWorkHints.hasTurnPrefixHumanUser
  ) {
    const summary = updateFileLists(previousSummary, fileOps);

    publishStatus?.(
      `Smart compaction: reused summary for harmless acknowledgement (${userTotalChars} user chars)…`,
      92,
    );

    log.debug("Smart compaction no-op accepted", {
      operation: "smart_compaction.noop_classification",
      classification: "harmless_acknowledgement",
      userMessageCount,
      userTotalChars,
      toolOutcomeCount: toolAnalysis.facts.length,
    });
    return {
      compaction: { summary, firstKeptEntryId, tokensBefore },
    };
  }

  log.debug("Smart compaction no-op rejected", {
    operation: "smart_compaction.noop_classification",
    classification: "summarize",
    reason: "meaningful_continuity_signal",
    isSplitTurn: !!preparation.isSplitTurn,
    userMessageCount,
    hasModifications,
    hasTopicShift: !!topicShift,
    toolOutcomesSafe: toolAnalysis.safeForNoOp,
    hasKeptUserContext: currentWorkHints.hasKeptUserContext,
    hasTurnPrefixHumanUser: currentWorkHints.hasTurnPrefixHumanUser,
  });
  return null;
}

/**
 * Build a compact mechanical description of what happened in a split-turn
 * window (tool calls only, no user messages).
 */
function buildMechanicalDelta(
  messages: Message[],
  modifiedFiles: string[],
  readFiles: string[],
  toolAnalysis: ToolOutcomeAnalysis,
): string {
  // Count tool calls by type
  const toolCounts: Record<string, number> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === "toolCall") {
          const name = block.name as string;
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    }
  }

  const parts: string[] = [];
  parts.push(
    `- Continued execution: ${messages.length} messages (split-turn, no new user input)`,
  );

  const toolSummary = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  if (toolSummary) parts.push(`- Tool calls: ${toolSummary}`);

  const outcomeFacts = toolAnalysis.facts.slice(0, 12).map((fact) => {
    const call = `${fact.toolName}${fact.keyArgument ? `(${fact.keyArgument})` : ""}`;
    if (fact.missing) return `${call}: unresolved (missing result)`;
    const state = fact.isError || fact.noChange ? "failed" : "succeeded";
    return `${call}: ${state}${fact.outcome ? ` — ${fact.outcome}` : ""}`;
  });
  if (outcomeFacts.length > 0) {
    parts.push(`- Tool outcomes:\n${outcomeFacts.map((fact) => `  - ${fact}`).join("\n")}`);
    if (toolAnalysis.facts.length > outcomeFacts.length) {
      parts.push(`- Additional low-information successes represented by the complete tool counts and canonical file lists: ${toolAnalysis.facts.length - outcomeFacts.length}`);
    }
  }

  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 10);
    parts.push(`- Files modified: ${shown.join(", ")}${modifiedFiles.length > 10 ? ` (+${modifiedFiles.length - 10} more)` : ""}`);
  }

  if (readFiles.length > 0) {
    parts.push(`- Files read: ${readFiles.length} files`);
  }

  return parts.join("\n");
}

/**
 * Append a mechanical delta to the previous summary, preserving structure.
 * Also updates the file lists at the end.
 */
function appendDeltaToSummary(
  previousSummary: string,
  delta: string,
  fileOps: FileOperations,
): string {
  // Strip old file-list tags from previous summary — we'll re-append fresh ones
  let base = previousSummary
    .replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trimEnd();

  // Split-turn outcomes are continuity facts, not future work. Insert them
  // inside Critical Context and keep every detail list-structured so the strict
  // terminal-section validator continues to hold.
  const criticalHeading = "## Critical Context";
  const criticalIdx = base.lastIndexOf(criticalHeading);
  if (criticalIdx > 0) {
    const bodyStart = criticalIdx + criticalHeading.length;
    base =
      base.slice(0, bodyStart) +
      `\n\n### Split-Turn Continuation\n${delta}` +
      base.slice(bodyStart);
  } else {
    base += `\n\n${criticalHeading}\n\n### Split-Turn Continuation\n${delta}`;
  }

  return appendFileLists(base, fileOps);
}

/**
 * Update file lists in a summary without changing anything else.
 */
function updateFileLists(summary: string, fileOps: FileOperations): string {
  const base = summary
    .replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trimEnd();

  return appendFileLists(base, fileOps);
}

/**
 * Append deterministic file-list tags to a summary string.
 */
export function appendFileLists(base: string, fileOps: FileOperations): string {
  const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);
  const parts: string[] = [base];

  if (readFiles.length > 0) {
    parts.push(`\n<read-files>\n${compressFilePaths(readFiles)}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(
      `\n<modified-files>\n${compressFilePaths(modifiedFiles)}\n</modified-files>`,
    );
  }

  return parts.join("\n");
}

/**
 * Replace model-authored file blocks with facts from deterministic tool
 * analysis. The model may copy stale blocks from a previous summary or invent
 * paths despite the prompt; neither is authoritative enough to persist.
 */
export function canonicalizeFileLists(base: string, fileOps: FileOperations): string {
  const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);
  const canonicalBase = base
    .replace(/\n*<read-files>[\s\S]*?<\/read-files>\s*/gi, "\n")
    .replace(/\n*<modified-files>[\s\S]*?<\/modified-files>\s*/gi, "\n")
    .trimEnd();
  const parts: string[] = [canonicalBase];
  if (readFiles.length > 0) {
    parts.push(`\n<read-files>\n${compressFilePaths(readFiles)}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(`\n<modified-files>\n${compressFilePaths(modifiedFiles)}\n</modified-files>`);
  }
  return parts.join("\n");
}
