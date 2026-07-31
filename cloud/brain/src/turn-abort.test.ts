import { describe, expect, it } from "bun:test";
import {
  TurnAbortedError,
  beginTurnAbortScope,
  clearTurnAbortScope,
  getTurnAbortSignal,
  isTurnAborted,
  signalTurnAbort,
  waitForTurnAbort,
} from "./turn-abort.ts";

describe("turn abort scope", () => {
  it("tracks abort within a turn scope", () => {
    beginTurnAbortScope("s1");
    expect(isTurnAborted("s1")).toBe(false);
    signalTurnAbort("s1");
    expect(isTurnAborted("s1")).toBe(true);
    clearTurnAbortScope("s1");
    expect(isTurnAborted("s1")).toBe(false);
  });

  it("throws TurnAbortedError with default message", () => {
    const error = new TurnAbortedError();
    expect(error.message).toBe("Turn aborted by user");
    expect(error.name).toBe("TurnAbortedError");
  });

  it("aborts the llm controller and resolves waiters", async () => {
    beginTurnAbortScope("s2");
    const signal = getTurnAbortSignal("s2");
    expect(signal?.aborted).toBe(false);
    const pending = waitForTurnAbort("s2");
    signalTurnAbort("s2");
    expect(signal?.aborted).toBe(true);
    await pending;
  });
});
