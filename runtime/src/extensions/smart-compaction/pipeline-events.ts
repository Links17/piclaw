/** Deterministic event grouping and canonical rendering for pipelined compaction. */
import type { Message } from "@piclaw/agent-kernel";
import {
  analyzeToolOutcomes,
  extractText,
  restrictToolAnalysisToAdjacentResultStream,
  serializeMessageLossless,
  serializeToolBatchLossless,
  type ToolOutcomeAnalysis,
} from "./messages.js";
import type { CompactionSourceEvent, CompactionSourceUnit, PreparedCompactionSource } from "./source.js";

export type PipelineEventKind =
  | "human_turn"
  | "assistant_narrative"
  | "tool_batch"
  | "orphan_tool_result"
  | "synthetic_context"
  | "ungrouped_context";

export interface PipelineEventGroup {
  id: string;
  kind: PipelineEventKind;
  sourceEvents: CompactionSourceEvent[];
  sourceIndexes: number[];
  sourceEntryIds: string[];
  llmMessageIndexes: number[];
  rendered: string;
}

function hasToolCall(message: Message): boolean {
  return message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block: any) => block?.type === "toolCall");
}

function rawFallback(event: CompactionSourceEvent): string {
  const content = event.rawMessage.content;
  const text = extractText(content);
  if (text) return `[${event.sourceIndex}|Context:${event.rawMessage.role}]: ${text}`;
  try {
    const serialized = JSON.stringify(content ?? event.rawMessage);
    return serialized && serialized !== "{}"
      ? `[${event.sourceIndex}|Context:${event.rawMessage.role}]: ${serialized}`
      : "";
  } catch {
    return `[${event.sourceIndex}|Context:${event.rawMessage.role}]: ${String(content ?? "")}`;
  }
}

function canonicalEventText(
  event: CompactionSourceEvent,
  source: PreparedCompactionSource,
  toolAnalysis: ToolOutcomeAnalysis,
): string {
  if (event.contextPruned && event.rawMessage.role === "toolResult") {
    const toolName = typeof (event.rawMessage as any).toolName === "string"
      ? (event.rawMessage as any).toolName
      : "tool";
    return `[${event.sourceIndex}|ContextPrunedToolResult:${toolName}]: raw outcome omitted from this request because context_prune retained its canonical summary; source provenance remains represented here.`;
  }
  const rendered: string[] = [];
  for (const llmIndex of event.modelSafeMessageIndexes) {
    const message = source.llmMessages[llmIndex];
    if (!message) continue;
    if (hasToolCall(message)) {
      const batch = serializeToolBatchLossless(source.llmMessages, llmIndex, toolAnalysis);
      if (batch) rendered.push(batch);
      continue;
    }
    const line = serializeMessageLossless(message, llmIndex, source.humanUserIndexes);
    if (line) rendered.push(line);
  }
  return rendered.join("\n") || rawFallback(event);
}

function eventKind(event: CompactionSourceEvent, toolAnalysis: ToolOutcomeAnalysis): PipelineEventKind {
  if (event.classification === "human") return "human_turn";
  if (event.classification === "synthetic") return "synthetic_context";
  if (event.classification === "tool") {
    const isOrphan = event.modelSafeMessageIndexes.some((index) => toolAnalysis.orphanResultIndexes.includes(index));
    return isOrphan ? "orphan_tool_result" : "ungrouped_context";
  }
  if (event.classification === "assistant") return "assistant_narrative";
  return "ungrouped_context";
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Group complete logical dependencies while retaining every contributing
 * source event exactly once. Tool IDs are used only to join local calls to
 * observed results; they are never emitted as semantic context.
 */
export function assemblePipelineEvents(
  source: PreparedCompactionSource,
  preparedToolAnalysis?: ToolOutcomeAnalysis,
): {
  groups: PipelineEventGroup[];
  toolAnalysis: ToolOutcomeAnalysis;
} {
  const toolAnalysis = preparedToolAnalysis ?? analyzeToolOutcomes(source.llmMessages);
  const eventBySourceIndex = new Map(source.sourceEvents.map((event) => [event.sourceIndex, event]));
  const sourceIndexByLlmIndex = source.sourceIndexesByLlmIndex;
  const consumed = new Set<number>();
  const groups: PipelineEventGroup[] = [];

  for (const event of source.sourceEvents) {
    if (consumed.has(event.sourceIndex)) continue;
    const assistantToolIndex = event.modelSafeMessageIndexes.find((index) => {
      const message = source.llmMessages[index];
      return !!message && hasToolCall(message);
    });

    let groupedEvents = [event];
    let kind = eventKind(event, toolAnalysis);
    let rendered = canonicalEventText(event, source, toolAnalysis);
    if (assistantToolIndex !== undefined) {
      // Keep a tool call with only its immediately adjacent result stream.
      // A result observed after human/assistant context is rendered later at
      // its true chronological position rather than moving that intervening
      // context behind an artificially wide tool group.
      const batchAnalysis = restrictToolAnalysisToAdjacentResultStream(source.llmMessages, assistantToolIndex, toolAnalysis);
      const resultSourceIndexes = batchAnalysis.facts
        .filter((fact) => fact.assistantIndex === assistantToolIndex && fact.resultIndex !== null)
        .map((fact) => sourceIndexByLlmIndex[fact.resultIndex as number])
        .filter((index): index is number => Number.isInteger(index));
      const allSourceIndexes = sortedUnique([event.sourceIndex, ...resultSourceIndexes]);
      groupedEvents = allSourceIndexes
        .map((sourceIndex) => eventBySourceIndex.get(sourceIndex))
        .filter((candidate): candidate is CompactionSourceEvent => !!candidate && !consumed.has(candidate.sourceIndex));
      kind = "tool_batch";
      rendered = serializeToolBatchLossless(source.llmMessages, assistantToolIndex, batchAnalysis)
        || groupedEvents.map((candidate) => canonicalEventText(candidate, source, toolAnalysis)).filter(Boolean).join("\n");
    }

    for (const groupedEvent of groupedEvents) consumed.add(groupedEvent.sourceIndex);
    const sourceIndexes = sortedUnique(groupedEvents.map((groupedEvent) => groupedEvent.sourceIndex));
    groups.push({
      id: `group-${String(groups.length + 1).padStart(4, "0")}`,
      kind,
      sourceEvents: groupedEvents,
      sourceIndexes,
      sourceEntryIds: [...new Set(groupedEvents.flatMap((groupedEvent) => groupedEvent.sourceEntryId ? [groupedEvent.sourceEntryId] : []))],
      llmMessageIndexes: sortedUnique(groupedEvents.flatMap((groupedEvent) => groupedEvent.modelSafeMessageIndexes)),
      rendered,
    });
  }

  return { groups, toolAnalysis };
}

/**
 * Project canonical groups into the shared progressive source-unit contract.
 * Selective progressive mode uses these complete units directly; Pipelined
 * adds categorical disposition metadata in its policy layer. Opaque entry IDs
 * remain machine-only provenance and are never embedded in model-visible text.
 */
export function buildCanonicalPipelineSourceUnits(groups: PipelineEventGroup[]): CompactionSourceUnit[] {
  return groups.map((group) => ({
    id: `representation-${group.id}`,
    groupId: group.id,
    renderedText: `### ${group.id} [source=${group.sourceIndexes.join(",")}]\n${group.rendered}`,
    sourceIndexes: [...group.sourceIndexes],
    sourceEntryIds: [...group.sourceEntryIds],
    segmentIndex: 1,
    segmentCount: 1,
  }));
}
