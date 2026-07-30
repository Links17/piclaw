import { describe, expect, it } from "bun:test";
import type { SkillPublicRow } from "./skills.ts";

describe("user skills API shape", () => {
  it("public rows exclude system scope and content", () => {
    const row: SkillPublicRow = {
      name: "my-skill",
      description: "desc",
      source: "installed",
      enabled: true,
      source_path: null,
    };
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("scope");
  });
});
