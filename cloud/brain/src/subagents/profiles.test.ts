import { describe, expect, test } from "bun:test";
import { buildSubagentUserPrompt, resolveSubagentProfile } from "./profiles.ts";

describe("profiles", () => {
  test("explore profile uses plan mode and replace prompt", async () => {
    const profile = await resolveSubagentProfile("explore", "sess-1");
    expect(profile.mode).toBe("plan");
    expect(profile.promptMode).toBe("replace");
    expect(profile.agentType).toBe("explore");
  });

  test("general-purpose profile uses coding tools", async () => {
    const profile = await resolveSubagentProfile("general-purpose", "sess-1");
    const tools = await profile.resolveTools("sess-1");
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("Agent");
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
