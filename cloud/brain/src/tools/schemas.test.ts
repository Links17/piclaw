import { describe, expect, test } from "bun:test";
import { mapInternalToSse } from "@piclaw-cloud/shared/sse-events";
import { getToolDefinitionsForMode, toolNamesForMode } from "./schemas.ts";

describe("tool schemas", () => {
  test("plan mode exposes readonly tools only", () => {
    const names = [...toolNamesForMode("plan")];
    expect(names).toContain("read");
    expect(names).toContain("question");
    expect(names).toContain("todo");
    expect(names).toContain("skill");
    expect(names).not.toContain("write");
    expect(names).not.toContain("Agent");
  });

  test("execute mode includes Agent and coding_agent", () => {
    const names = [...toolNamesForMode("execute")];
    expect(names).toContain("Agent");
    expect(names).toContain("coding_agent");
    expect(names).toContain("get_subagent_result");
  });

  test("todo_update maps to agent_draft plan panel", () => {
    const mapped = mapInternalToSse(
      { chatJid: "web:test", turnId: "1" },
      { type: "todo_update", markdown: "- [ ] task", replica: "A" },
    );
    expect(mapped?.event).toBe("agent_draft");
    expect(mapped?.data.kind).toBe("plan");
  });

  test("getToolDefinitionsForMode returns array", () => {
    expect(getToolDefinitionsForMode("plan").length).toBeGreaterThan(0);
  });
});
