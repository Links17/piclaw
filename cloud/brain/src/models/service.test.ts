import { describe, expect, test } from "bun:test";

describe("model slash commands", () => {
  test("preserves provider-qualified model labels", async () => {
    const { parseModelSlashCommand } = await import("./service.ts");
    expect(parseModelSlashCommand("/model local/llama3")).toEqual({
      type: "model",
      target: "local/llama3",
    });
  });

});
