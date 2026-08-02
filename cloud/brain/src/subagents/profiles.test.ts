import { describe, expect, test } from "bun:test";
import {
  buildSubagentUserPrompt,
  filterServiceToolDefinitions,
  resolveSubagentProfile,
} from "./profiles.ts";

describe("profiles", () => {
  test("explore profile uses plan mode and replace prompt", async () => {
    const profile = await resolveSubagentProfile("explore", "sess-1");
    expect(profile.mode).toBe("plan");
    expect(profile.promptMode).toBe("replace");
    expect(profile.agentType).toBe("explore");
    expect(profile.executionBackend).toBe("sandbox");
    expect(profile.runner).toBe("kernel");
  });

  test("general-purpose profile uses coding tools", async () => {
    const profile = await resolveSubagentProfile("general-purpose", "sess-1");
    const tools = await profile.resolveTools("sess-1");
    const names = tools.map((tool) => tool.function.name);
    expect(profile.executionBackend).toBe("sandbox");
    expect(profile.runner).toBe("coding-worker");
    expect(names).toContain("bash");
    expect(names).not.toContain("Agent");
  });

  test("research profile runs without sandbox coding tools", async () => {
    const profile = await resolveSubagentProfile("research", "sess-1");
    const tools = await profile.resolveTools("sess-1");
    const names = tools.map((tool) => tool.function.name);

    expect(profile.executionBackend).toBe("service");
    expect(profile.runner).toBe("kernel");
    expect(profile.mode).toBe("plan");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
  });

  test("service profiles retain remote capabilities without sandbox tools", () => {
    const tools = filterServiceToolDefinitions([
      { type: "function", function: { name: "read", description: "", parameters: {} } },
      { type: "function", function: { name: "question", description: "", parameters: {} } },
      { type: "function", function: { name: "mcp__web__search", description: "", parameters: {} } },
    ]);

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "question",
      "mcp__web__search",
    ]);
  });

  test("buildSubagentUserPrompt includes constraints", () => {
    const prompt = buildSubagentUserPrompt(
      { promptMode: "replace" } as never,
      "do work",
      "stay readonly",
    );
    expect(prompt).toContain("Constraints:");
    expect(prompt).toContain("stay readonly");
  });
});
