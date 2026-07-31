import { describe, expect, test } from "bun:test";
import {
  fallbackTitleFromMessage,
  sanitizeGeneratedTitle,
} from "./session-title.ts";

describe("session-title helpers", () => {
  test("sanitizeGeneratedTitle strips quotes and collapses whitespace", () => {
    expect(sanitizeGeneratedTitle('"Hello   world"')).toBe("Hello world");
    expect(sanitizeGeneratedTitle("  Line\nbreak  title  ")).toBe("Line break title");
  });

  test("fallbackTitleFromMessage truncates long messages", () => {
    const long = "a".repeat(100);
    const title = fallbackTitleFromMessage(long);
    expect(title.endsWith("...")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  test("fallbackTitleFromMessage returns placeholder for empty input", () => {
    expect(fallbackTitleFromMessage("   ")).toBe("New chat");
  });
});
