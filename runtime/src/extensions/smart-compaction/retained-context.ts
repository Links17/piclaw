/** Render the retained live window and split-turn prefix for compaction prompts. */
import type { Message } from "@piclaw/agent-kernel";
import { KEPT_CONTEXT_BUDGET_CHARS } from "./config.js";
import {
  analyzeToolOutcomes,
  buildPreview,
  convertMessagesWithMetadata,
  extractText,
  isRealUserSourceMessage,
  selectRecentContextBackwards,
  serializeMessage,
  serializeToolBatchCompact,
  type SourceMessage,
} from "./messages.js";

function normalizeSerializedLine(line: string): string {
  return line.replace(/^\[\d+\|([^\]]+)\]:\s*/, "[$1]: ");
}

function compactInlineText(text: string, maxChars = 240): string {
  return buildPreview(text.replace(/\s+/g, " ").trim(), maxChars);
}

function serializeKeptEntryMessage(message: SourceMessage, followingToolResults: SourceMessage[] = []): string[] {
  const lines: string[] = [];

  if (message.role === "assistant") {
    const batchCtx = convertMessagesWithMetadata([message, ...followingToolResults]);
    const assistantLlm = batchCtx.llmMessages[0];
    const hasToolCalls = Array.isArray((assistantLlm as any)?.content) &&
      ((assistantLlm as any).content as any[]).some((b: any) => b.type === "toolCall");

    if (assistantLlm && hasToolCalls) {
      const analysis = analyzeToolOutcomes(batchCtx.llmMessages);
      const compact = serializeToolBatchCompact(batchCtx.llmMessages, 0, analysis);
      if (compact) lines.push(normalizeSerializedLine(compact));
      for (const orphanIndex of analysis.orphanResultIndexes) {
        const orphan = batchCtx.llmMessages[orphanIndex];
        if (!orphan) continue;
        const line = serializeMessage(orphan, orphanIndex, batchCtx.humanUserIndexes);
        if (line) lines.push(normalizeSerializedLine(line));
      }
      return lines;
    }
  }

  const ctx = convertMessagesWithMetadata([message]);
  for (let i = 0; i < ctx.llmMessages.length; i++) {
    const line = serializeMessage(ctx.llmMessages[i], i, ctx.humanUserIndexes);
    if (line) lines.push(normalizeSerializedLine(line));
  }

  return lines;
}

/**
 * Extract a compact summary of the kept window (the entries that survive
 * compaction) from the full session entries. This tells the LLM what current
 * work will remain in context after the new summary, including user turns,
 * assistant/tool progress, branch summaries, and extension custom messages.
 */
export function extractKeptMessagesSummary(
  branchEntries: any[],
  firstKeptEntryId: string,
): { summary: string; hasHumanUser: boolean } {
  let foundKept = false;
  const lines: string[] = [];
  let hasHumanUser = false;

  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry.id === firstKeptEntryId) foundKept = true;
    if (!foundKept) continue;
    if (entry.type === "compaction") continue;

    if (entry.type === "message" && entry.message) {
      const message = entry.message as SourceMessage;
      if (isRealUserSourceMessage(message)) hasHumanUser = true;

      const followingToolResults: SourceMessage[] = [];
      const hasToolCalls = message.role === "assistant"
        && Array.isArray((message as any).content)
        && ((message as any).content as any[]).some((block: any) => block.type === "toolCall");
      if (hasToolCalls) {
        for (let resultIndex = i + 1; resultIndex < branchEntries.length; resultIndex++) {
          const resultEntry = branchEntries[resultIndex];
          if (resultEntry?.type !== "message" || resultEntry.message?.role !== "toolResult") break;
          followingToolResults.push(resultEntry.message as SourceMessage);
        }
      }

      const serialized = serializeKeptEntryMessage(message, followingToolResults);
      if (serialized.length > 0) lines.push(...serialized);
      i += followingToolResults.length;
      continue;
    }

    if (entry.type === "custom_message") {
      const text = extractText(entry.content).trim();
      if (!text) continue;
      lines.push(`[Context:${entry.customType ?? "custom"}]: ${compactInlineText(text, 400)}`);
      continue;
    }

    if (entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (!summary) continue;
      lines.push(`[BranchSummary]: ${compactInlineText(summary, 400)}`);
    }
  }

  if (lines.length === 0) return { summary: "", hasHumanUser };

  const selected: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (selected.length > 0 && chars + line.length > KEPT_CONTEXT_BUDGET_CHARS) break;
    selected.push(line);
    chars += line.length;
  }

  selected.reverse();
  return { summary: selected.join("\n"), hasHumanUser };
}

export function buildTurnPrefixSummary(
  turnPrefixMessages: Message[],
  humanUserIndexes: Set<number>,
): string {
  if (turnPrefixMessages.length === 0) return "";

  const { included, compactOverrides } = selectRecentContextBackwards(
    turnPrefixMessages,
    humanUserIndexes,
  );
  const rendered = new Map<number, string>();
  for (const idx of included) {
    const line = compactOverrides.get(idx) ?? serializeMessage(turnPrefixMessages[idx], idx, humanUserIndexes);
    if (line) rendered.set(idx, line);
  }

  const nearestHumanUserIndex = [...included]
    .filter((idx) => humanUserIndexes.has(idx) && rendered.has(idx))
    .sort((a, b) => b - a)[0];
  const selected = new Set<number>();
  let chars = 0;
  if (nearestHumanUserIndex !== undefined) {
    selected.add(nearestHumanUserIndex);
    chars += rendered.get(nearestHumanUserIndex)!.length;
  }
  for (const idx of [...included].sort((a, b) => b - a)) {
    if (selected.has(idx)) continue;
    const line = rendered.get(idx);
    if (!line) continue;
    if (selected.size > 0 && chars + line.length > KEPT_CONTEXT_BUDGET_CHARS) {
      const remaining = KEPT_CONTEXT_BUDGET_CHARS - chars;
      if (remaining < 256) continue;
      const notice = "… [older batch detail trimmed; newest outcomes follow] …\n";
      rendered.set(idx, `${notice}${line.slice(-(remaining - notice.length))}`);
      selected.add(idx);
      chars = KEPT_CONTEXT_BUDGET_CHARS;
      continue;
    }
    selected.add(idx);
    chars += line.length;
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((idx) => rendered.get(idx))
    .filter((line): line is string => !!line)
    .join("\n");
}
