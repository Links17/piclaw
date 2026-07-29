import { describe, expect, test } from "bun:test";
import { mapInternalToWeb } from "@piclaw-cloud/shared/sse-events";

describe("subagent sse mapping", () => {
  test("maps subagent_started to tool status", () => {
    const mapped = mapInternalToWeb("s1", {
      type: "subagent_started",
      runId: "run-1",
      agentType: "coding",
      task: "write demo",
      replica: "A",
    });
    expect(mapped).toEqual({ type: "agent_status", status: "tool", detail: "coding:run-1" });
  });
});
