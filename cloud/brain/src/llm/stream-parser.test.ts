import { describe, expect, test } from "bun:test";
import { applyStreamChunk, createStreamAccumulator, finalizeStreamAccumulator } from "./stream-parser.ts";

describe("stream tool call aggregation", () => {
  test("accumulates split tool call argument chunks", () => {
    const acc = createStreamAccumulator();
    applyStreamChunk(acc, {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: "{\"path\":" } }],
        },
      }],
    });
    applyStreamChunk(acc, {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: "\"/workspace/a.ino\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const done = finalizeStreamAccumulator(acc);
    expect(done.toolCalls).toEqual([
      { id: "call_1", name: "write", arguments: "{\"path\":\"/workspace/a.ino\"}" },
    ]);
    expect(done.finishReason).toBe("tool_calls");
  });

  test("accumulates text deltas", () => {
    const acc = createStreamAccumulator();
    const first = applyStreamChunk(acc, { choices: [{ delta: { content: "hello" } }] });
    const second = applyStreamChunk(acc, { choices: [{ delta: { content: " world" } }] });
    expect(first.textDelta).toBe("hello");
    expect(second.textDelta).toBe(" world");
    expect(finalizeStreamAccumulator(acc).text).toBe("hello world");
  });
});
