/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@piclaw/agent-kernel";
import { checkPiclawCompactionBudget } from "../../agent-pool/compaction-trigger-context.js";
import { RECENT_CONTEXT_BUDGET_CHARS, TOOL_RESULT_MAX_CHARS, USER_PREVIEW_MAX_CHARS } from "./config.js";

export function extractText(content: unknown): string {
  return extractTextRaw(content).trim();
}

function extractTextRaw(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function describeImageBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const images = (content as any[]).filter((block) => block?.type === "image");
  if (images.length === 0) return "";
  const mediaTypes = [...new Set(images
    .map((block) => typeof block.mimeType === "string" ? block.mimeType : "image")
    .filter(Boolean))];
  return `[${images.length} image attachment${images.length === 1 ? "" : "s"}${mediaTypes.length ? `: ${mediaTypes.join(", ")}` : ""}]`;
}

// ---------------------------------------------------------------------------
// Synthetic message detection
// ---------------------------------------------------------------------------

/**
 * Prefixes used by pi upstream's convertToLlm to wrap compaction/branch
 * summaries as user-role messages. We must skip these in every function
 * that looks for real user turns.
 */
const COMPACTION_SUMMARY_USER_PREFIX = "The conversation history before this point was compacted into the following summary:";
const BRANCH_SUMMARY_USER_PREFIX = "The following is a summary of a branch that this conversation came back from:";

/** True only for the prior-compaction wrapper supplied separately as previousSummary. */
export function isCompactionSummaryUserMessage(msg: Message): boolean {
  return msg.role === "user" && extractText(msg.content).startsWith(COMPACTION_SUMMARY_USER_PREFIX);
}

/** True for a branch-summary wrapper whose body remains source-bearing history. */
export function isBranchSummaryUserMessage(msg: Message): boolean {
  return msg.role === "user" && extractText(msg.content).startsWith(BRANCH_SUMMARY_USER_PREFIX);
}

/** True when a user-role LLM message is any synthetic summary wrapper. */
export function isSyntheticUserMessage(msg: Message): boolean {
  return isCompactionSummaryUserMessage(msg) || isBranchSummaryUserMessage(msg);
}

/** True when an LLM user-role message came from a real human user turn. */
export function isRealUserMessage(msg: Message, idx: number, humanUserIndexes?: Set<number>): boolean {
  if (msg.role !== "user") return false;
  if (isSyntheticUserMessage(msg)) return false;
  const text = extractText(msg.content).trim();
  if (text.startsWith("/")) return false;
  if (!text && !describeImageBlocks(msg.content)) return false;
  return humanUserIndexes ? humanUserIndexes.has(idx) : true;
}

export type SourceMessage = {
  role: string;
  content?: unknown;
  excludeFromContext?: boolean;
};

export function isRealUserSourceMessage(msg: SourceMessage): boolean {
  if (msg.role !== "user") return false;
  const text = extractText(msg.content).trim();
  return !text.startsWith("/") && (!!text || !!describeImageBlocks(msg.content));
}

export function convertMessagesWithMetadata(sourceMessages: SourceMessage[]): {
  llmMessages: Message[];
  humanUserIndexes: Set<number>;
  sourceIndexesByLlmIndex: number[];
} {
  const llmMessages: Message[] = [];
  const humanUserIndexes = new Set<number>();
  const sourceIndexesByLlmIndex: number[] = [];

  for (let sourceIndex = 0; sourceIndex < sourceMessages.length; sourceIndex += 1) {
    checkPiclawCompactionBudget("smart_compaction.messages.convert");
    const source = sourceMessages[sourceIndex];
    const converted = convertToLlm([source as any]);
    if (converted.length === 0) continue;
    const start = llmMessages.length;
    llmMessages.push(...converted);
    for (let i = 0; i < converted.length; i += 1) {
      sourceIndexesByLlmIndex[start + i] = sourceIndex;
    }
    if (isRealUserSourceMessage(source)) {
      for (let i = 0; i < converted.length; i++) {
        humanUserIndexes.add(start + i);
      }
    }
  }

  return { llmMessages, humanUserIndexes, sourceIndexesByLlmIndex };
}

export function buildPreview(text: string, maxChars = USER_PREVIEW_MAX_CHARS): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "..." : text;
}

const TOOL_OUTCOME_MAX_CHARS = 180;
const TOOL_NAME_MAX_CHARS = 60;
const FAILURE_OUTCOME_REGEX = /\b(error|failed|failure|exception|permission denied|timed? out|not found|unable to|cannot|could not)\b/i;
const ZERO_FAILURE_OUTCOME_REGEX = /\b(?:0|no)\s+(?:tests?\s+)?(?:failed|failures?|errors?|exceptions?)\b/gi;
const NO_CHANGE_OUTCOME_REGEX = /\b(?:applied\s*:\s*0|no changes? (?:applied|made)|nothing (?:changed|written)|replacement (?:text )?was not found)\b/i;
const SIGNIFICANT_OUTCOME_REGEX = /\b(?:tests?|passed|warning|critical|blocked|disk\s+(?:is\s+)?full|deploy|restart|deleted)\b/i;
const LOW_INFORMATION_MUTATION_SUCCESS_REGEX = /\b(?:ok|done|success(?:ful(?:ly)?)?|applied|created|updated|edited|wrote|written)\b/i;
const LOW_INFORMATION_MUTATION_TOOLS = new Set(["edit", "write"]);
const MUTATION_STATUS_TOOLS = new Set(["edit", "write"]);
const COMMAND_STATUS_TOOLS = new Set(["bash", "exec", "shell"]);
const COMMAND_FAILURE_OUTCOME_REGEX = /(?:\b(?:exit|status|code)\s*[:=]?\s*[1-9]\d*\b|\bcommand failed\b|\b[1-9]\d*\s+(?:tests?\s+)?failed\b|\bfatal:\s)/i;
const LOW_INFORMATION_READ_RESULT_REGEX = /^(?:read\s+)?ok[.!]?$/i;

export interface ToolOutcomeFact {
  callId: string;
  toolName: string;
  assistantIndex: number;
  resultIndex: number | null;
  keyArgument: string;
  exactKeyArgument: string;
  pathArgument: string;
  outcome: string;
  isError: boolean;
  missing: boolean;
  noChange: boolean;
  significant: boolean;
  lowInformationSuccess: boolean;
}

export interface ToolOutcomeAnalysis {
  facts: ToolOutcomeFact[];
  matchedResultIndexes: Set<number>;
  orphanResultIndexes: number[];
  hasAssistantNarrative: boolean;
  hasFailure: boolean;
  hasMissing: boolean;
  hasSignificantOutcome: boolean;
  safeForNoOp: boolean;
}

function compactToolOutcome(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= TOOL_OUTCOME_MAX_CHARS) return compact;
  // Command/test failures and summaries commonly appear at the end of output.
  // Preserve both boundaries instead of retaining only a misleading prefix.
  const marker = " … ";
  const headChars = Math.ceil((TOOL_OUTCOME_MAX_CHARS - marker.length) / 2);
  const tailChars = TOOL_OUTCOME_MAX_CHARS - marker.length - headChars;
  return `${compact.slice(0, headChars)}${marker}${compact.slice(-tailChars)}`;
}

function hasFailureOutcome(text: string): boolean {
  // Successful test summaries often contain phrases such as "0 failed" or
  // "no errors". Remove only those zero-count clauses before looking for real
  // failure evidence so prompt serialization never labels a passing run ERROR.
  return FAILURE_OUTCOME_REGEX.test(text.replace(ZERO_FAILURE_OUTCOME_REGEX, ""));
}

function toolCallKeyArgument(block: any): string {
  const args = block?.arguments ?? {};
  const value = args.path ?? args.command ?? args.pattern ?? args.query ?? "";
  return typeof value === "string" ? buildPreview(value.replace(/\s+/g, " ").trim(), 100) : "";
}

/** Providers may append an opaque `|...` signature to one side of a tool ID pair. */
function baseToolCallId(value: string): string {
  return value.split("|", 1)[0]?.trim() || value;
}

function toolCallIdsMatch(callId: string, resultId: string): boolean {
  return callId === resultId || baseToolCallId(callId) === baseToolCallId(resultId);
}

/**
 * Reconcile assistant tool-call batches with all consecutive matching results.
 * Outcome text is normalized and capped so callers never copy unbounded tool output.
 */
export function analyzeToolOutcomes(messages: Message[]): ToolOutcomeAnalysis {
  const facts: ToolOutcomeFact[] = [];
  const matchedResultIndexes = new Set<number>();
  let hasAssistantNarrative = false;

  const nearestPriorMatchingAssistantIndex = (resultIndex: number, toolCallId: string): number | null => {
    for (let candidateIndex = resultIndex - 1; candidateIndex >= 0; candidateIndex--) {
      const candidate = messages[candidateIndex];
      if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
      const calls = (candidate.content as any[])
        .filter((block) => block?.type === "toolCall" && typeof block.id === "string");
      if (calls.some((call) => toolCallIdsMatch(call.id, toolCallId))) return candidateIndex;
    }
    return null;
  };

  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex++) {
    checkPiclawCompactionBudget("smart_compaction.messages.analyze.assistant");
    const assistant = messages[assistantIndex];
    if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) continue;
    const blocks = assistant.content as any[];
    const calls = blocks.filter((block) => block?.type === "toolCall" && typeof block.id === "string");
    if (blocks.some((block) =>
      (block?.type === "text" && block.text?.trim())
      || (block?.type === "thinking" && block.thinking?.trim())
    )) hasAssistantNarrative = true;
    if (calls.length === 0) continue;

    const consecutiveResults: Array<{ message: Message; index: number; toolCallId: string }> = [];
    for (let resultIndex = assistantIndex + 1; resultIndex < messages.length; resultIndex++) {
      checkPiclawCompactionBudget("smart_compaction.messages.analyze.results");
      const result = messages[resultIndex] as any;
      if (result.role !== "toolResult") break;
      if (typeof result.toolCallId === "string") {
        consecutiveResults.push({ message: result, index: resultIndex, toolCallId: result.toolCallId });
      }
    }
    const claimedResultIndexes = new Set<number>();
    const laterResults: Array<{ message: Message; index: number; toolCallId: string }> = [];
    for (let resultIndex = assistantIndex + 1; resultIndex < messages.length; resultIndex++) {
      const result = messages[resultIndex] as any;
      if (result.role === "toolResult" && typeof result.toolCallId === "string") {
        laterResults.push({ message: result, index: resultIndex, toolCallId: result.toolCallId });
      }
    }

    for (const call of calls) {
      // Prefer consecutive exact/base-ID matches. Providers and parallel tool
      // execution can return results out of order or after unrelated context;
      // fall back to the later stream by stable call ID so those outcomes are
      // still associated without giving replay IDs semantic meaning.
      const isUnclaimed = (result: { index: number }) =>
        !matchedResultIndexes.has(result.index) && !claimedResultIndexes.has(result.index);
      const ownedByThisAssistant = (result: { index: number; toolCallId: string }) =>
        nearestPriorMatchingAssistantIndex(result.index, result.toolCallId) === assistantIndex;
      const matched = consecutiveResults.find((result) =>
        isUnclaimed(result) && ownedByThisAssistant(result) && result.toolCallId === call.id,
      ) ?? consecutiveResults.find((result) =>
        isUnclaimed(result) && ownedByThisAssistant(result) && toolCallIdsMatch(call.id, result.toolCallId),
      ) ?? laterResults.find((result) =>
        isUnclaimed(result) && ownedByThisAssistant(result) && result.toolCallId === call.id,
      ) ?? laterResults.find((result) =>
        isUnclaimed(result) && ownedByThisAssistant(result) && toolCallIdsMatch(call.id, result.toolCallId),
      );
      const rawOutcome = matched
        ? [extractTextRaw(matched.message.content), describeImageBlocks(matched.message.content)].filter(Boolean).join("\n")
        : "";
      const outcome = compactToolOutcome(rawOutcome);
      const toolName = typeof call.name === "string" ? call.name : "?";
      const exactKeyValue = call.arguments?.path ?? call.arguments?.command ?? call.arguments?.pattern ?? call.arguments?.query ?? "";
      const exactKeyArgument = typeof exactKeyValue === "string" ? exactKeyValue.trim() : "";
      const isError = !!(matched?.message as any)?.isError
        || (MUTATION_STATUS_TOOLS.has(toolName) && hasFailureOutcome(rawOutcome))
        || (COMMAND_STATUS_TOOLS.has(toolName) && (COMMAND_FAILURE_OUTCOME_REGEX.test(rawOutcome) || hasFailureOutcome(rawOutcome)));
      const missing = !matched;
      const noChange = NO_CHANGE_OUTCOME_REGEX.test(rawOutcome);
      const lowInformationSuccess = !!matched
        && !isError
        && !noChange
        && !SIGNIFICANT_OUTCOME_REGEX.test(rawOutcome)
        && rawOutcome.length <= 500
        && (
          (LOW_INFORMATION_MUTATION_TOOLS.has(toolName) && LOW_INFORMATION_MUTATION_SUCCESS_REGEX.test(rawOutcome))
          || (toolName === "read" && LOW_INFORMATION_READ_RESULT_REGEX.test(rawOutcome.trim()))
        );
      const significant = missing
        || isError
        || noChange
        || !lowInformationSuccess
        || SIGNIFICANT_OUTCOME_REGEX.test(rawOutcome);

      if (matched) {
        matchedResultIndexes.add(matched.index);
        claimedResultIndexes.add(matched.index);
      }
      facts.push({
        callId: call.id,
        toolName,
        assistantIndex,
        resultIndex: matched?.index ?? null,
        keyArgument: toolCallKeyArgument(call),
        exactKeyArgument,
        pathArgument: typeof call.arguments?.path === "string" ? call.arguments.path : "",
        outcome,
        isError,
        missing,
        noChange,
        significant,
        lowInformationSuccess,
      });
    }
  }

  const orphanResultIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "toolResult" && !matchedResultIndexes.has(i)) orphanResultIndexes.push(i);
  }
  const hasFailure = facts.some((fact) => fact.isError || fact.noChange) || orphanResultIndexes.length > 0;
  const hasMissing = facts.some((fact) => fact.missing);
  const hasSignificantOutcome = facts.some((fact) => fact.significant) || orphanResultIndexes.length > 0;

  return {
    facts,
    matchedResultIndexes,
    orphanResultIndexes,
    hasAssistantNarrative,
    hasFailure,
    hasMissing,
    hasSignificantOutcome,
    safeForNoOp: !hasAssistantNarrative && !hasFailure && !hasMissing && !hasSignificantOutcome,
  };
}

/**
 * Restrict one tool batch to its immediately adjacent result stream.
 *
 * Global outcome analysis deliberately associates a stable call ID with a
 * later result for file/state reconciliation. Canonical source rendering must
 * be stricter: moving that later result ahead of intervening human or
 * assistant context would violate chronology. The delayed result remains a
 * standalone source event at its observed position.
 */
export function restrictToolAnalysisToAdjacentResultStream(
  messages: Message[],
  assistantIndex: number,
  analysis: ToolOutcomeAnalysis,
): ToolOutcomeAnalysis {
  const isAdjacent = (resultIndex: number | null): boolean => {
    if (resultIndex === null || resultIndex <= assistantIndex) return false;
    for (let index = assistantIndex + 1; index <= resultIndex; index += 1) {
      if (messages[index]?.role !== "toolResult") return false;
    }
    return true;
  };
  const facts = analysis.facts
    .filter((fact) => fact.assistantIndex === assistantIndex)
    .map((fact) => {
      if (isAdjacent(fact.resultIndex)) return fact;
      return {
        ...fact,
        resultIndex: null,
        outcome: "",
        isError: false,
        missing: true,
        noChange: false,
        significant: true,
        lowInformationSuccess: false,
      };
    });
  const matchedResultIndexes = new Set(facts
    .filter((fact) => fact.resultIndex !== null)
    .map((fact) => fact.resultIndex as number));
  const hasFailure = facts.some((fact) => fact.isError || fact.noChange);
  const hasMissing = facts.some((fact) => fact.missing);
  const hasSignificantOutcome = facts.some((fact) => fact.significant);
  return {
    facts,
    matchedResultIndexes,
    orphanResultIndexes: [],
    hasAssistantNarrative: analysis.hasAssistantNarrative,
    hasFailure,
    hasMissing,
    hasSignificantOutcome,
    safeForNoOp: !analysis.hasAssistantNarrative && !hasFailure && !hasMissing && !hasSignificantOutcome,
  };
}

/** Serialize a complete assistant tool batch with each matched result exactly once. */
export function serializeToolBatchCompact(
  messages: Message[],
  assistantIndex: number,
  analysis = analyzeToolOutcomes(messages),
): string {
  const facts = analysis.facts.filter((fact) => fact.assistantIndex === assistantIndex);
  if (facts.length === 0) return "";
  const assistantMessage = messages[assistantIndex];
  const narrative = assistantMessage?.role === "assistant" && Array.isArray(assistantMessage.content)
    ? (assistantMessage.content as any[])
        .filter((block: any) =>
          (block.type === "text" && typeof block.text === "string" && block.text.trim())
          || (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
        )
        .map((block: any) => block.type === "thinking" ? `[thinking] ${block.thinking.trim()}` : block.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
    : "";
  const rendered = facts.map((fact) => {
    const call = `${buildPreview(fact.toolName, TOOL_NAME_MAX_CHARS)}(${fact.keyArgument})`;
    if (fact.missing) return `${call} → MISSING RESULT`;
    const state = fact.isError || fact.noChange ? "ERROR: " : "";
    return fact.outcome ? `${call} → ${state}${fact.outcome}` : `${call} → (empty result)`;
  });
  if (narrative) rendered.unshift(`Assistant: ${buildPreview(narrative, 400)}`);
  // Do not cap whole batches. Selective execution detects when this complete
  // representation cannot fit and routes it through progressive chunking,
  // which can split one large batch without dropping tail outcomes.
  return `[${assistantIndex}|Tool]: ${rendered.join(" | ")}`;
}

/** Serialize one complete tool batch without omitting any observed result text. */
export function serializeToolBatchLossless(
  messages: Message[],
  assistantIndex: number,
  analysis = analyzeToolOutcomes(messages),
): string {
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return "";
  const facts = analysis.facts.filter((fact) => fact.assistantIndex === assistantIndex);
  if (facts.length === 0) return "";
  const blocks = assistant.content as any[];
  const narrative = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const thinking = blocks
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("\n");
  const calls = blocks.filter((block) => block?.type === "toolCall" && typeof block.id === "string");
  const rendered = facts.map((fact) => {
    const call = calls.find((candidate) => candidate.id === fact.callId);
    let args: string;
    try { args = JSON.stringify(call?.arguments ?? {}); } catch { args = String(call?.arguments ?? ""); }
    const callText = `${fact.toolName}(${args})`;
    if (fact.missing || fact.resultIndex === null) return `${callText} → MISSING RESULT`;
    const result = messages[fact.resultIndex] as any;
    const resultText = [extractTextRaw(result?.content), describeImageBlocks(result?.content)].filter(Boolean).join("\n");
    const state = result?.isError || fact.isError || fact.noChange ? "ERROR: " : "";
    return `${callText} → ${state}${resultText || "(empty result)"}`;
  });
  if (narrative) rendered.unshift(`Assistant: ${narrative}`);
  if (thinking) rendered.unshift(`Assistant thinking: ${thinking}`);
  return `[${assistantIndex}|Tool]: ${rendered.join("\n")}`;
}

/** Serialize one message without bounded previews; progressive mode splits it safely. */
export function serializeMessageLossless(msg: Message, idx: number, humanUserIndexes?: Set<number>): string {
  if (msg.role === "toolResult") {
    const text = extractText(msg.content);
    const images = describeImageBlocks(msg.content);
    if (!text && !images) return "";
    const status = (msg as any).isError ? "ERROR:" : "";
    return `[${idx}|ToolResult:${status}${(msg as any).toolName ?? "?"}]: ${[text, images].filter(Boolean).join("\n")}`;
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const block of (Array.isArray(msg.content) ? msg.content : []) as any[]) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block?.type === "thinking" && typeof block.thinking === "string") parts.push(`[thinking]: ${block.thinking}`);
      else if (block?.type === "toolCall") {
        let args: string;
        try { args = JSON.stringify(block.arguments ?? {}); } catch { args = String(block.arguments ?? ""); }
        parts.push(`→ ${block.name ?? "?"}(${args})`);
      } else if (block?.type === "image") parts.push(describeImageBlocks([block]));
    }
    return parts.length ? `[${idx}|Assistant]: ${parts.join("\n")}` : "";
  }
  // User/context wrappers are already lossless except for the deliberately
  // deduplicated prior-compaction marker handled by serializeMessage().
  return serializeMessage(msg, idx, humanUserIndexes);
}

/** Serialize one LLM message to a compact readable line. */
export function serializeMessage(msg: Message, idx: number, humanUserIndexes?: Set<number>): string {
  if (msg.role === "user") {
    if (isCompactionSummaryUserMessage(msg)) {
      // The actual prior compaction summary is supplied once in its dedicated
      // prompt section, so this wrapper can be represented by a provenance marker.
      return `[${idx}|CompactionSummary]: (previous compaction summary — see Previous Summary section)`;
    }
    if (isBranchSummaryUserMessage(msg)) {
      // A branch summary is distinct historical context, not a duplicate of
      // previousSummary. Preserve its complete body so progressive splitting
      // can represent every unique branch constraint.
      return `[${idx}|BranchSummary]: ${extractText(msg.content)}`;
    }
    const text = extractText(msg.content);
    const images = describeImageBlocks(msg.content);
    const rendered = [text, images].filter(Boolean).join("\n");
    if (!rendered) return "";
    return humanUserIndexes?.has(idx)
      ? `[${idx}|User]: ${rendered}`
      : `[${idx}|Context]: ${rendered}`;
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const block of msg.content as any[]) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(`[thinking]: ${buildPreview(block.thinking, 400)}`);
      else if (block.type === "toolCall") {
        const args = block.arguments ?? {};
        const summary = args.path ?? args.command ?? JSON.stringify(args);
        const trunc =
          typeof summary === "string" && summary.length > 120
            ? summary.slice(0, 117) + "..."
            : summary;
        parts.push(`→ ${block.name}(${trunc})`);
      } else if (block.type === "image") {
        parts.push(describeImageBlocks([block]));
      }
    }
    return parts.length ? `[${idx}|Assistant]: ${parts.join(" | ")}` : "";
  }
  if (msg.role === "toolResult") {
    const text = extractText(msg.content);
    const images = describeImageBlocks(msg.content);
    if (!text && !images) return "";
    let bounded = text;
    if (text.length > TOOL_RESULT_MAX_CHARS) {
      // Test/command summaries and provider errors commonly appear at the end.
      // Preserve both boundaries so a bounded progressive source line cannot
      // turn a failed tool call into an apparently successful one.
      const headChars = Math.ceil(TOOL_RESULT_MAX_CHARS / 2);
      const tailChars = TOOL_RESULT_MAX_CHARS - headChars;
      bounded = `${text.slice(0, headChars)}\n… (${text.length - TOOL_RESULT_MAX_CHARS} chars truncated) …\n${text.slice(-tailChars)}`;
    }
    const status = (msg as any).isError ? "ERROR:" : "";
    return `[${idx}|ToolResult:${status}${(msg as any).toolName ?? "?"}]: ${[bounded, images].filter(Boolean).join("\n")}`;
  }
  return "";
}

/**
 * Walk backwards from the end of the message array, capturing user intent
 * with full fidelity while aggressively compressing tool call/result pairs.
 *
 * Returns a set of message indices to include, plus pre-rendered compact
 * versions for tool pairs (overrides the normal serializeMessage output).
 */
export function selectRecentContextBackwards(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): { included: Set<number>; compactOverrides: Map<number, string> } {
  const included = new Set<number>();
  const compactOverrides = new Map<number, string>();
  const toolAnalysis = analyzeToolOutcomes(messages);
  const adjacentResultIndexes = new Set<number>();
  for (const assistantIndex of new Set(toolAnalysis.facts.map((fact) => fact.assistantIndex))) {
    const localAnalysis = restrictToolAnalysisToAdjacentResultStream(messages, assistantIndex, toolAnalysis);
    for (const fact of localAnalysis.facts) {
      if (fact.assistantIndex === assistantIndex && fact.resultIndex !== null) {
        adjacentResultIndexes.add(fact.resultIndex);
      }
    }
  }
  let budget = RECENT_CONTEXT_BUDGET_CHARS;

  // Reserve the nearest real human turn before walking backwards. Otherwise a
  // large final tool batch can consume the full budget and erase the active
  // instruction that initiated it (especially in split-turn compaction).
  let reservedUserIndex = -1;
  for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
    if (!isRealUserMessage(messages[candidate], candidate, humanUserIndexes)) continue;
    const line = serializeMessage(messages[candidate], candidate, humanUserIndexes);
    if (line) {
      reservedUserIndex = candidate;
      included.add(candidate);
      budget -= line.length;
    }
    break;
  }

  let i = messages.length - 1;
  while (i >= 0 && budget > 0) {
    checkPiclawCompactionBudget("smart_compaction.messages.select_recent");
    const msg = messages[i];

    if (i === reservedUserIndex) {
      i--;
      continue;
    }

    if (msg.role === "user") {
      if (isCompactionSummaryUserMessage(msg)) {
        // The prior compaction summary is supplied separately — skip it here.
        i--;
        continue;
      }
      // Keep user-role context, but only real human turns are labeled as User.
      const line = serializeMessage(msg, i, humanUserIndexes);
      included.add(i);
      budget -= line.length;
      i--;
      continue;
    }

    if (msg.role === "assistant") {
      const hasToolCalls = Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "toolCall");
      const hasText = Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "text" && b.text?.trim());

      if (hasToolCalls) {
        const batchAnalysis = restrictToolAnalysisToAdjacentResultStream(messages, i, toolAnalysis);
        const compact = serializeToolBatchCompact(messages, i, batchAnalysis);
        if (compact) {
          included.add(i);
          compactOverrides.set(i, compact);
          for (const fact of batchAnalysis.facts) {
            if (fact.assistantIndex !== i || fact.resultIndex === null) continue;
            included.add(fact.resultIndex);
            compactOverrides.set(fact.resultIndex, "");
          }
          budget -= compact.length;
        }
        i--;
        continue;
      }

      if (hasText) {
        // Assistant explanatory text — keep full
        const line = serializeMessage(msg, i, humanUserIndexes);
        included.add(i);
        budget -= line.length;
        i--;
        continue;
      }
    }

    if (msg.role === "toolResult") {
      // Orphans and delayed results have no chronological adjacent batch to
      // carry their outcome. Preserve the bounded result at its observed
      // position so intervening intent is never reordered.
      if (!adjacentResultIndexes.has(i)) {
        const line = serializeMessage(msg, i, humanUserIndexes);
        if (line) {
          included.add(i);
          budget -= line.length;
        }
      }
      i--;
      continue;
    }

    i--;
  }

  return { included, compactOverrides };
}

// ---------------------------------------------------------------------------
// Fragment selection
// ---------------------------------------------------------------------------
