import { describe, expect, test } from "bun:test";
import { resolveWorkspacePath } from "./path.ts";

describe("resolveWorkspacePath", () => {
  test("accepts absolute workspace paths", () => {
    expect(resolveWorkspacePath("/workspace/demo.ino")).toBe("/workspace/demo.ino");
  });

  test("resolves relative paths under workspace", () => {
    expect(resolveWorkspacePath("demo.ino")).toBe("/workspace/demo.ino");
  });

  test("rejects traversal", () => {
    expect(() => resolveWorkspacePath("/workspace/../etc/passwd")).toThrow("must not contain ..");
  });

  test("rejects paths outside workspace", () => {
    expect(() => resolveWorkspacePath("/etc/passwd")).toThrow("must be under /workspace");
  });
});
