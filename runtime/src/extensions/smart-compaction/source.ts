/** Shared provenance-bearing discarded-source projection for all compaction methods. */
import type { Message } from "@piclaw/agent-kernel";
import type { FileOperations } from "@earendil-works/pi-coding-agent";
import {
  convertMessagesWithMetadata,
  isRealUserSourceMessage,
  isSyntheticUserMessage,
  type SourceMessage,
} from "./messages.js";

export type CompactionSourceClassification = "human" | "synthetic" | "assistant" | "tool" | "context";

export interface CompactionSourceEvent {
  /** Stable chronological position in the complete discarded stream. */
  sourceIndex: number;
  sourceEntryId?: string;
  rawMessage: SourceMessage;
  /** Sanitized provider-neutral projections derived from this exact source event. */
  modelSafeMessages: Message[];
  modelSafeMessageIndexes: number[];
  classification: CompactionSourceClassification;
  /** Context-prune may replace a call and omit its already-summarized raw result. */
  contextPruned: boolean;
}

export interface CompactionSourceUnit {
  id: string;
  groupId: string;
  renderedText: string;
  sourceIndexes: number[];
  sourceEntryIds: string[];
  segmentIndex: number;
  segmentCount: number;
}

export interface PreparedCompactionSource {
  rawMessages: SourceMessage[];
  modelSafeSourceMessages: SourceMessage[];
  llmMessages: Message[];
  humanUserIndexes: Set<number>;
  /** Complete discarded-stream source index for every LLM message. */
  sourceIndexesByLlmIndex: number[];
  sourceEntryIdsByLlmIndex: Array<string | undefined>;
  sourceEvents: CompactionSourceEvent[];
  previousSummary?: string;
  retainedContext: string;
  customInstructions?: string;
  fileOps: FileOperations;
}

function classifySourceEvent(
  rawMessage: SourceMessage,
  projectedMessages: Message[],
): CompactionSourceClassification {
  // Upstream projects branch/compaction summaries as user-role LLM messages.
  // Classify those wrappers before ordinary user turns so their synthetic
  // continuity text is preserved without being mistaken for fresh intent.
  if (
    rawMessage.role === "compactionSummary"
    || rawMessage.role === "branchSummary"
    || projectedMessages.some(isSyntheticUserMessage)
  ) return "synthetic";
  if (isRealUserSourceMessage(rawMessage)) return "human";
  if (rawMessage.role === "assistant") return "assistant";
  if (rawMessage.role === "toolResult") return "tool";
  return "context";
}

export function prepareCompactionSource(input: {
  rawMessages: SourceMessage[];
  rawSourceEntryIds: Array<string | undefined>;
  modelSafeSourceMessages: SourceMessage[];
  modelSafeSourceIndexes: number[];
  previousSummary?: string;
  retainedContext?: string;
  customInstructions?: string;
  fileOps: FileOperations;
}): PreparedCompactionSource {
  const converted = convertMessagesWithMetadata(input.modelSafeSourceMessages);
  const sourceIndexesByLlmIndex = converted.sourceIndexesByLlmIndex.map(
    (modelSafeIndex) => input.modelSafeSourceIndexes[modelSafeIndex] ?? modelSafeIndex,
  );
  const sourceEntryIdsByLlmIndex = sourceIndexesByLlmIndex.map(
    (sourceIndex) => input.rawSourceEntryIds[sourceIndex],
  );
  const llmIndexesBySource = new Map<number, number[]>();
  sourceIndexesByLlmIndex.forEach((sourceIndex, llmIndex) => {
    const indexes = llmIndexesBySource.get(sourceIndex) ?? [];
    indexes.push(llmIndex);
    llmIndexesBySource.set(sourceIndex, indexes);
  });

  const retainedSourceIndexes = new Set(input.modelSafeSourceIndexes);
  const sourceEvents = input.rawMessages.map((rawMessage, sourceIndex): CompactionSourceEvent => {
    const modelSafeMessageIndexes = llmIndexesBySource.get(sourceIndex) ?? [];
    const modelSafeMessages = modelSafeMessageIndexes.map((index) => converted.llmMessages[index]!);
    return {
      sourceIndex,
      sourceEntryId: input.rawSourceEntryIds[sourceIndex],
      rawMessage,
      modelSafeMessages,
      modelSafeMessageIndexes,
      classification: classifySourceEvent(rawMessage, modelSafeMessages),
      contextPruned: !retainedSourceIndexes.has(sourceIndex),
    };
  });

  return {
    rawMessages: input.rawMessages,
    modelSafeSourceMessages: input.modelSafeSourceMessages,
    llmMessages: converted.llmMessages,
    humanUserIndexes: converted.humanUserIndexes,
    sourceIndexesByLlmIndex,
    sourceEntryIdsByLlmIndex,
    sourceEvents,
    previousSummary: input.previousSummary,
    retainedContext: input.retainedContext?.trim() ?? "",
    customInstructions: input.customInstructions,
    fileOps: input.fileOps,
  };
}
