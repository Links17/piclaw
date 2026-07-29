import { describe, expect, test } from "bun:test";
import { applyUniqueEdit } from "./edit.ts";

describe("applyUniqueEdit", () => {
  test("replaces a single unique match", () => {
    expect(applyUniqueEdit("hello world", "hello world", "hello agent")).toBe("hello agent");
  });

  test("rejects zero matches", () => {
    expect(() => applyUniqueEdit("foo", "bar", "baz")).toThrow("old_string not found");
  });

  test("rejects multiple matches", () => {
    expect(() => applyUniqueEdit("aa", "a", "b")).toThrow("appears 2 times");
  });
});
