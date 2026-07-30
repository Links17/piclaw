import { describe, expect, test } from "bun:test";
import { allocateSubagentRunId, normalizeSubagentRunId } from "./run-id.ts";

describe("subagent run id", () => {
  test("normalizeSubagentRunId rejects empty and whitespace", () => {
    expect(normalizeSubagentRunId("")).toBeNull();
    expect(normalizeSubagentRunId("   ")).toBeNull();
    expect(normalizeSubagentRunId(undefined)).toBeNull();
    expect(normalizeSubagentRunId("run-abc")).toBe("run-abc");
    expect(normalizeSubagentRunId("  run-abc  ")).toBe("run-abc");
  });

  test("allocateSubagentRunId generates uuid when resume is blank", () => {
    const id = allocateSubagentRunId("");
    expect(id.startsWith("run-")).toBe(true);
    expect(id.length).toBeGreaterThan("run-".length);
  });

  test("allocateSubagentRunId preserves valid resume id", () => {
    expect(allocateSubagentRunId("run-existing")).toBe("run-existing");
  });
});
