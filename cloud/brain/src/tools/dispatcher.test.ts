import { describe, expect, test } from "bun:test";
import { dispatchTool } from "./dispatcher.ts";
import { resetActiveToolNames } from "./active.ts";

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
});
