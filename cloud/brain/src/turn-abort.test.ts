import { describe, expect, it } from "bun:test";
import {
  TurnAbortedError,
  beginTurnAbortScope,
  clearTurnAbortScope,
  isTurnAborted,
  signalTurnAbort,
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
});
