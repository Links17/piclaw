import { describe, expect, test } from "bun:test";
import { mapInternalToSse } from "@piclaw-cloud/shared/sse-events";
import {
  getToolCatalog,
  getToolDefinitionsForMode,
  toolNamesForMode,
} from "./schemas.ts";

describe("tool schemas", () => {
  test("plan mode exposes only the discovery baseline", () => {
    const names = [...toolNamesForMode("plan")];
    expect(names).toContain("read");
    expect(names).toContain("question");
    expect(names).toContain("todo");
    expect(names).toContain("skill");
    expect(names).toContain("list_tools");
    expect(names).toContain("activate_tools");
    expect(names).toContain("reset_active_tools");
    expect(names).not.toContain("write");
    expect(names).not.toContain("Agent");
  });

  test("execute mode starts with discovery baseline instead of all tools", () => {
    const names = [...toolNamesForMode("execute")];
    expect(names).toContain("list_tools");
    expect(names).toContain("coding_agent");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("Agent");
  });

  test("active tools augment the baseline without exposing inactive tools", () => {
    const names = [...toolNamesForMode("execute", [], new Set(["bash", "Agent"]))];
    expect(names).toContain("bash");
    expect(names).toContain("Agent");
    expect(names).not.toContain("write");
  });

  test("catalog includes subagent and MCP tools for activation", () => {
    const catalog = getToolCatalog([
      {
        type: "function",
        function: {
          name: "mcp__docs__search",
          description: "Search docs",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(catalog.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["Agent", "coding_agent", "mcp__docs__search"]),
    );
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
