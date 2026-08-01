import { describe, expect, test } from "bun:test";
import type { MessageRow } from "@piclaw-cloud/store";
import {
  buildCompactionWindow,
  compactionSummaryToAgentMessage,
  compactToolResultText,
  expandCompactionWindow,
  hydrateWithCompaction,
  validateCompactionSummary,
} from "./smart-compaction.ts";

function row(
  id: number,
  role: MessageRow["role"],
  content: string,
  contentBlocks: unknown = null,
): MessageRow {
  return {
    id,
    session_id: "session-1",
    role,
    content,
    content_blocks: contentBlocks,
    recovery_marker: false,
    created_at: new Date(id * 1000).toISOString(),
  };
}

describe("buildCompactionWindow", () => {
  test("reserves the full estimated summary budget on the first compaction", () => {
    const rows = [
      row(1, "user", "old"),
      row(2, "assistant", "answer"),
      row(3, "user", "current"),
    ];
    const result = buildCompactionWindow(rows, {
      contextWindow: 100,
      reserveTokens: 20,
      estimatedSummaryTokens: 60,
      estimateRowTokens: () => 25,
    });
    expect(result).toMatchObject({
      overflow: { budgetTokens: 20, currentTurnTokens: 25 },
    });
  });

  test("selects a complete retained tail by token budget instead of a fixed count", () => {
    const rows = [
      row(1, "user", "old question"),
      row(2, "assistant", "old answer"),
      row(3, "user", "medium question"),
      row(4, "assistant", "medium answer"),
      row(5, "user", "current request"),
    ];
    const tokenCosts = new Map([[1, 20], [2, 20], [3, 35], [4, 35], [5, 25]]);

    const result = buildCompactionWindow(rows, {
      contextWindow: 130,
      reserveTokens: 20,
      estimatedSummaryTokens: 10,
      estimateRowTokens: (entry) => tokenCosts.get(entry.id) ?? 0,
    });

    expect(result?.rowsToSummarize.map((entry) => entry.id)).toEqual([1, 2]);
    expect(result?.retainedRows.map((entry) => entry.id)).toEqual([3, 4, 5]);
  });

  test("returns overflow metadata when the current turn alone exceeds the usable budget", () => {
    const rows = [
      row(1, "user", "current request"),
      row(2, "assistant", "", {
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      row(3, "tool", "huge output", { tool_call_id: "call-1", tool_name: "bash" }),
    ];

    const result = buildCompactionWindow(rows, {
      contextWindow: 100,
      reserveTokens: 20,
      estimatedSummaryTokens: 10,
      estimateRowTokens: () => 40,
    });

    expect(result).toMatchObject({
      overflow: {
        code: "context_overflow",
        budgetTokens: 70,
        currentTurnTokens: 120,
      },
    });
  });

  test("summarizes complete old turns and retains the newest tail", () => {
    const rows = [
      row(1, "user", "old question"),
      row(2, "assistant", "old answer"),
      row(3, "user", "new question"),
      row(4, "assistant", "new answer"),
      row(5, "user", "current request"),
    ];

    const result = buildCompactionWindow(rows, { keepRecentMessages: 3 });

    expect(result?.rowsToSummarize.map((entry) => entry.id)).toEqual([1, 2]);
    expect(result?.retainedRows.map((entry) => entry.id)).toEqual([3, 4, 5]);
    expect(result?.compactedThroughMessageId).toBe(2);
  });

  test("does not split an assistant tool call from its result", () => {
    const rows = [
      row(1, "user", "run command"),
      row(2, "assistant", "", {
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      row(3, "tool", "command output", { tool_call_id: "call-1", tool_name: "bash" }),
      row(4, "assistant", "done"),
      row(5, "user", "next"),
    ];

    const result = buildCompactionWindow(rows, { keepRecentMessages: 2 });

    expect(result?.rowsToSummarize.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(result?.retainedRows.map((entry) => entry.id)).toEqual([4, 5]);
  });

  test("moves the cut before a tool call when its result would be retained", () => {
    const rows = [
      row(1, "user", "older"),
      row(2, "assistant", "older answer"),
      row(3, "user", "run command"),
      row(4, "assistant", "", {
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      row(5, "tool", "command output", { tool_call_id: "call-1", tool_name: "bash" }),
      row(6, "assistant", "done"),
    ];

    const result = buildCompactionWindow(rows, { keepRecentMessages: 2 });

    expect(result?.rowsToSummarize.map((entry) => entry.id)).toEqual([1, 2]);
    expect(result?.retainedRows.map((entry) => entry.id)).toEqual([3, 4, 5, 6]);
  });

  test("keeps a user prompt and assistant response on the same side of the cut", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(index + 1, index % 2 === 0 ? "user" : "assistant", `message ${index + 1}`)
    );

    const result = buildCompactionWindow(rows, { keepRecentMessages: 5 });

    expect(result?.rowsToSummarize.at(-1)?.role).toBe("assistant");
    expect(result?.retainedRows[0]?.role).toBe("user");
  });

  test("summarizes only rows after the previous compaction boundary", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(index + 1, index % 2 === 0 ? "user" : "assistant", `message ${index + 1}`)
    );

    const result = buildCompactionWindow(rows, {
      keepRecentMessages: 4,
      afterMessageId: 4,
    });

    expect(result?.rowsToSummarize.map((entry) => entry.id)).toEqual([5, 6, 7, 8]);
    expect(result?.retainedRows.map((entry) => entry.id)).toEqual([9, 10, 11, 12]);
    expect(result?.compactedThroughMessageId).toBe(8);
  });

  test("returns no window when preserving a complete current turn leaves no summary prefix", () => {
    const rows = [
      row(1, "user", "current request"),
      row(2, "assistant", "", {
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      row(3, "tool", "output", { tool_call_id: "call-1", tool_name: "bash" }),
      row(4, "assistant", "current answer"),
    ];

    expect(buildCompactionWindow(rows, { keepRecentMessages: 0 })).toBeNull();
  });

  test("never returns an empty retained tail", () => {
    const rows = [
      row(1, "user", "old request"),
      row(2, "assistant", "old answer"),
      row(3, "user", "current request"),
    ];

    const result = buildCompactionWindow(rows, { keepRecentMessages: 0 });

    expect(result?.retainedRows.length).toBeGreaterThan(0);
    expect(result?.retainedRows.at(-1)?.id).toBe(3);
  });
});

describe("expandCompactionWindow", () => {
  test("moves one complete retained turn into the summary with a strictly increasing boundary", () => {
    const initial = {
      rowsToSummarize: [row(1, "user", "old"), row(2, "assistant", "old answer")],
      retainedRows: [
        row(3, "user", "middle"),
        row(4, "assistant", "middle answer"),
        row(5, "user", "current"),
      ],
      compactedThroughMessageId: 2,
    };
    const expanded = expandCompactionWindow(initial);
    expect(expanded?.rowsToSummarize.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(expanded?.retainedRows.map((entry) => entry.id)).toEqual([5]);
    expect(expanded!.compactedThroughMessageId).toBeGreaterThan(initial.compactedThroughMessageId);
    expect(expandCompactionWindow(expanded!)).toBeNull();
  });
});

describe("hydrateWithCompaction", () => {
  test("replaces compacted history with one persisted summary", () => {
    const rows = [
      row(1, "user", "old question"),
      row(2, "assistant", "old answer"),
      row(3, "user", "new question"),
    ];

    const hydrated = hydrateWithCompaction(rows, {
      id: 7,
      sessionId: "session-1",
      compactedThroughMessageId: 2,
      summary: "## Goal\nContinue the migration.",
      tokensBefore: 90_000,
      createdAt: new Date().toISOString(),
    });

    expect(hydrated).toHaveLength(2);
    expect(hydrated[0]).toMatchObject({
      role: "system",
      content: "## Goal\nContinue the migration.",
      content_blocks: { kind: "compaction_summary", tokens_before: 90_000 },
    });
    expect(hydrated[1]?.id).toBe(3);
  });

  test("converts a persisted summary into the pi compaction message role", () => {
    const message = compactionSummaryToAgentMessage({
      id: 7,
      sessionId: "session-1",
      compactedThroughMessageId: 2,
      summary: "## Goal\nContinue.",
      tokensBefore: 42_000,
      createdAt: new Date(0).toISOString(),
    });

    expect(message).toEqual({
      role: "compactionSummary",
      summary: "## Goal\nContinue.",
      tokensBefore: 42_000,
      timestamp: 0,
    });
  });
});

describe("compactToolResultText", () => {
  test("keeps the beginning, ending, and omission count of large tool output", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
    const compacted = compactToolResultText(text, { maxChars: 140, edgeLines: 3 });

    expect(compacted).toContain("line-0");
    expect(compacted).toContain("line-99");
    expect(compacted).toContain("94 lines omitted");
    expect(compacted.length).toBeLessThan(text.length);
    expect(compacted.length).toBeLessThanOrEqual(140);
  });

  test("always respects maxChars for an oversized single line", () => {
    const compacted = compactToolResultText("x".repeat(10_000), { maxChars: 37 });

    expect(compacted.length).toBeLessThanOrEqual(37);
    expect(compacted).toContain("…");
  });

  test("always respects maxChars for oversized edge lines", () => {
    const text = Array.from({ length: 100 }, (_, index) =>
      `${index}:${"x".repeat(500)}`
    ).join("\n");

    const compacted = compactToolResultText(text, { maxChars: 90, edgeLines: 20 });

    expect(compacted.length).toBeLessThanOrEqual(90);
  });
});

describe("validateCompactionSummary", () => {
  test("rejects truncated, oversized, and unstructured summaries", () => {
    expect(validateCompactionSummary({
      text: "## Goal\nKeep going.\n\n## Next Steps\nRun tests.",
      stopReason: "length",
      maxChars: 1_000,
    })).toEqual({ valid: false, reason: "stop_reason_length" });
    expect(validateCompactionSummary({
      text: "x".repeat(101),
      stopReason: "stop",
      maxChars: 100,
    })).toEqual({ valid: false, reason: "summary_too_long" });
    expect(validateCompactionSummary({
      text: "plain paragraph without durable sections",
      stopReason: "stop",
      maxChars: 1_000,
    })).toEqual({ valid: false, reason: "summary_structure_invalid" });
  });

  test("accepts a bounded structured summary", () => {
    expect(validateCompactionSummary({
      text: "## Goal\nKeep going.\n\n## Constraints\nDo not delete data.\n\n## Next Steps\nRun tests.",
      stopReason: "stop",
      maxChars: 1_000,
    })).toEqual({ valid: true });
  });
});
