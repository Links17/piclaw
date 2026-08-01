import { describe, expect, test } from "bun:test";
import { boundHistoryThroughMessageId } from "./history-bound.ts";

describe("boundHistoryThroughMessageId", () => {
  test("excludes queued follow-up user messages that arrived after the inflight turn", () => {
    const rows = [
      { id: 10, role: "user" },
      { id: 11, role: "assistant" },
      { id: 12, role: "user" }, // inflight
      { id: 13, role: "user" }, // queued follow-up already persisted
    ];
    expect(boundHistoryThroughMessageId(rows, 12).map((row) => row.id)).toEqual([10, 11, 12]);
  });
});
