import { describe, expect, test } from "bun:test";
import { dispatchTool } from "./dispatcher.ts";
import { resetActiveToolNames } from "./active.ts";
import { toolNamesForMode } from "./schemas.ts";

describe("tool discovery dispatcher", () => {
  const sessionId = "tool-discovery-test";

  test("activates a core tool for subsequent dispatches", async () => {
    resetActiveToolNames(sessionId);

    const before = await dispatchTool(sessionId, "bash", { command: "pwd" });
    expect(before.isError).toBe(true);

    const activation = await dispatchTool(sessionId, "activate_tools", { names: ["bash"] });
    expect(activation.isError).toBe(false);

    const after = await dispatchTool(sessionId, "bash", { command: "pwd" });
    expect(after.output).not.toContain("Tool not available");
  });

  test("lists MCP tools and permits activation", async () => {
    resetActiveToolNames(sessionId);
    const mcpTool = {
      type: "function" as const,
      function: {
        name: "mcp__docs__search",
        description: "Search documentation",
        parameters: { type: "object" },
      },
    };

    const listing = await dispatchTool(sessionId, "list_tools", {}, "execute", [mcpTool]);
    expect(listing.output).toContain("mcp__docs__search");

    const activation = await dispatchTool(
      sessionId,
      "activate_tools",
      { names: ["mcp__docs__search"] },
      "execute",
      [mcpTool],
    );
    expect(activation.isError).toBe(false);
  });

  test("reset revokes previously activated tools", async () => {
    resetActiveToolNames(sessionId);
    await dispatchTool(sessionId, "activate_tools", { names: ["bash"] });
    await dispatchTool(sessionId, "reset_active_tools", {});

    const result = await dispatchTool(sessionId, "bash", { command: "pwd" });
    expect(result.isError).toBe(true);
  });

  test("strict profiles reject tools outside their exact allowlist", async () => {
    resetActiveToolNames(sessionId);
    await dispatchTool(sessionId, "activate_tools", { names: ["bash"] });

    const result = await dispatchTool(
      sessionId,
      "bash",
      { command: "pwd" },
      "plan",
      [],
      new Set(["question"]),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("strict profile");
  });

  test("rejects incomplete scheduled task creation before any persistence", async () => {
    const result = await dispatchTool(
      sessionId,
      "scheduled_tasks",
      { action: "create", schedule_type: "cron", schedule_value: "0 10 * * *" },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      action: "create",
      confirmed: false,
      error: "schedule_type, schedule_value, and prompt are required",
    });
  });

  test("makes scheduled task management available to the main agent", () => {
    expect(toolNamesForMode("execute")).toContain("scheduled_tasks");
  });

  test("rejects scheduled task management from a strict service profile", async () => {
    const result = await dispatchTool(
      sessionId,
      "scheduled_tasks",
      { action: "list" },
      "execute",
      [],
      new Set(["question"]),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("strict profile");
  });
});
