import { describe, expect, it } from "bun:test";
import { formatSkillsForPrompt, type SkillCatalogEntry } from "./registry.ts";

describe("skill registry formatting", () => {
  it("formats catalog for prompt with skill tool hint", () => {
    const entries: SkillCatalogEntry[] = [
      { name: "web-search", description: "Search the web", scope: "user", source: "installed" },
    ];
    const text = formatSkillsForPrompt(entries);
    expect(text).toContain("skill tool");
    expect(text).toContain("web-search");
    expect(text).not.toContain("/workspace/.pi/skills");
  });

  it("returns empty string for empty catalog", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
});

describe("skill catalog merge", () => {
  it("user scope overrides system with same name", async () => {
    const { mergeCatalogRowsForTest } = await import("./registry.test-helpers.ts");
    const merged = mergeCatalogRowsForTest([
      {
        id: "system:demo",
        scope: "system",
        user_id: null,
        name: "demo",
        description: "system copy",
        content: "system content",
        source: "builtin",
        source_path: null,
        enabled: true,
        created_at: "",
        updated_at: "",
      },
      {
        id: "user:u1:demo",
        scope: "user",
        user_id: "u1",
        name: "demo",
        description: "user copy",
        content: "user content",
        source: "installed",
        source_path: null,
        enabled: true,
        created_at: "",
        updated_at: "",
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("user copy");
    expect(merged[0]?.scope).toBe("user");
  });
});

describe("skill cache", () => {
  it("invalidates per-user cache entries", async () => {
    const { getCachedCatalog, invalidateSkillCache, setCachedCatalog, resetSkillCacheForTests } = await import("./cache.ts");
    resetSkillCacheForTests();
    setCachedCatalog("user-a", [{ name: "a", description: "", scope: "user", source: "installed" }]);
    expect(getCachedCatalog("user-a")).not.toBeNull();
    invalidateSkillCache("user-a");
    expect(getCachedCatalog("user-a")).toBeNull();
  });
});
