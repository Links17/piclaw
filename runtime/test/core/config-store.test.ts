import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import "../helpers.js";
import { createTempWorkspace } from "../helpers.js";
import { readJsonConfig, writeJsonConfig } from "../../src/core/config-store.js";

describe("config-store helpers", () => {
  test("readJsonConfig returns an empty object for missing, invalid, or scalar JSON files", () => {
    const workspace = createTempWorkspace("piclaw-config-store-read-");
    try {
      const missingPath = join(workspace.workspace, "missing.json");
      expect(readJsonConfig(missingPath)).toEqual({});

      const invalidPath = join(workspace.workspace, "invalid.json");
      writeFileSync(invalidPath, "{not-json", "utf8");
      expect(readJsonConfig(invalidPath)).toEqual({});

      const scalarPath = join(workspace.workspace, "number.json");
      writeFileSync(scalarPath, "42", "utf8");
      expect(readJsonConfig(scalarPath)).toEqual({});
    } finally {
      workspace.cleanup();
    }
  });

  test("writeJsonConfig creates parent directories and pretty-prints with a trailing newline", () => {
    const workspace = createTempWorkspace("piclaw-config-store-write-");
    try {
      const targetPath = join(workspace.workspace, ".seeed", "nested", "config.json");
      writeJsonConfig(targetPath, {
        web: { trustProxy: true },
        assistant: { assistantName: "PiClaw" },
      });

      expect(existsSync(targetPath)).toBe(true);
      expect(readJsonConfig(targetPath)).toEqual({
        web: { trustProxy: true },
        assistant: { assistantName: "PiClaw" },
      });
      expect(readFileSync(targetPath, "utf8").endsWith("\n")).toBe(true);
    } finally {
      workspace.cleanup();
    }
  });
});
