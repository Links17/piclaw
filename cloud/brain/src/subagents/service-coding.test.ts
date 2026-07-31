import { describe, expect, test } from "bun:test";
import { formatCodingSubagentToolResult } from "./service.ts";

describe("coding subagent gateway", () => {
  test("formatCodingSubagentToolResult returns structured envelope", () => {
    const text = formatCodingSubagentToolResult({
      runId: "run-1",
      status: "completed",
      summary: "Created demo.ino",
      artifacts: ["demo.ino"],
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.run_id).toBe("run-1");
    expect(parsed.status).toBe("completed");
    expect(parsed.artifacts).toEqual(["demo.ino"]);
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });
});
