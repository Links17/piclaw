import { describe, expect, test } from "bun:test";
import { executableHelloLines, hasLegacyHelloOutput } from "./arduino-output.ts";

describe("Arduino E2E output checks", () => {
  test("ignores comments and prose but detects legacy display or serial output", () => {
    const content = [
      "// old hello world reference",
      "Simple Hello World demo for the Seeed Studio Wio Terminal.",
      'Serial.println("hello world");',
      'tft.print("hello agent");',
    ].join("\n");

    expect(executableHelloLines(content)).toEqual([
      'Serial.println("hello world");',
      'tft.print("hello agent");',
    ]);
    expect(hasLegacyHelloOutput(content)).toBe(true);
  });

  test("accepts a sketch whose executable output only uses hello agent", () => {
    const content = [
      "// hello world was replaced",
      'Serial.println("hello agent");',
      'tft.print("hello agent");',
    ].join("\n");

    expect(hasLegacyHelloOutput(content)).toBe(false);
  });
});
