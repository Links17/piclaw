import { describe, expect, test } from "bun:test";
import { parseModelSlashCommand } from "./service.ts";

describe("model slash commands", () => {
  test("preserves provider-qualified model labels", () => {
    expect(parseModelSlashCommand("/model local/llama3")).toEqual({
      type: "model",
      target: "local/llama3",
    });
  });
});
