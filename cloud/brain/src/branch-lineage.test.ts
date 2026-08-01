import { describe, expect, test } from "bun:test";
import {
  normalizeForkMessageId,
  normalizeForkTitle,
} from "./branch-lineage.ts";

describe("branch lineage helpers", () => {
  test("accepts a positive fork message id only", () => {
    expect(normalizeForkMessageId(42)).toBe(42);
    expect(normalizeForkMessageId("42")).toBe(42);
    expect(normalizeForkMessageId(0)).toBeNull();
    expect(normalizeForkMessageId("bad")).toBeNull();
  });

  test("creates a readable fork title when no title is supplied", () => {
    expect(normalizeForkTitle("  Experiment  ", "Parent")).toBe("Experiment");
    expect(normalizeForkTitle("", "Parent")).toBe("Parent (fork)");
  });
});
