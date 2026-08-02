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

  test("execute mode exposes the canonical Agent orchestrator", () => {
    const names = [...toolNamesForMode("execute")];
    expect(names).toContain("list_tools");
    expect(names).toContain("Agent");
    expect(names).toContain("scheduled_tasks");
    expect(names).not.toContain("bash");
    expect(names).toContain("coding_agent");
    expect(getToolDefinitionsForMode("execute").map((tool) => tool.function.name))
      .not.toContain("coding_agent");
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
      expect.arrayContaining(["Agent", "mcp__docs__search"]),
    );
    expect(catalog.map((tool) => tool.name)).not.toContain("coding_agent");
  });

  test("Agent describes immediate delegation boundaries and research execution", () => {
    const execute = getToolDefinitionsForMode("execute", []);
    const agent = execute.find((tool) => tool.function.name === "Agent");
    const parameters = agent?.function.parameters as {
      properties?: { subagent_type?: { enum?: string[] }; schedule?: unknown; timezone?: unknown };
    } | undefined;

    expect(agent).toBeDefined();
    expect(parameters?.properties?.subagent_type?.enum).toContain("research");
    expect(agent?.function.description).toContain("repository-dependent");
    expect(agent?.function.description).toContain("persistent scheduled work");
    expect(parameters?.properties?.schedule).toBeUndefined();
    expect(parameters?.properties?.timezone).toBeUndefined();
  });

  test("scheduled_tasks is a first-class execution tool with structured actions", () => {
    const execute = getToolDefinitionsForMode("execute", []);
    const scheduledTasks = execute.find((tool) => tool.function.name === "scheduled_tasks");
    const parameters = scheduledTasks?.function.parameters as {
      properties?: {
        action?: { enum?: string[] };
        schedule_type?: { enum?: string[] };
        timezone?: { description?: string };
      };
    } | undefined;

    expect(scheduledTasks).toBeDefined();
    expect(parameters?.properties?.action?.enum).toEqual(
      expect.arrayContaining(["create", "list", "get", "pause", "resume", "delete"]),
    );
    expect(parameters?.properties?.schedule_type?.enum).toEqual(
      expect.arrayContaining(["cron", "interval", "once"]),
    );
    expect(parameters?.properties?.timezone?.description).toContain("IANA");
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
