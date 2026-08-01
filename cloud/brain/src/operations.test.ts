import { describe, expect, test } from "bun:test";
import {
  beginDrain,
  beginOperation,
  beginOperationIfAccepting,
  drainingResponse,
  getActiveOperationCounts,
  getActiveRequestCount,
  isDraining,
  resetOperationsForTest,
  trackActiveRequest,
  waitForDrain,
} from "./operations.ts";

describe("brain drain state", () => {
  test("tracks explicit operation handles by kind until idempotent completion", () => {
    resetOperationsForTest();
    const turn = beginOperation("turn");
    const sidePrompt = beginOperation("side_prompt");

    expect(getActiveRequestCount()).toBe(2);
    expect(getActiveOperationCounts()).toEqual({ turn: 1, side_prompt: 1 });

    turn.finish();
    turn.finish();
    expect(getActiveOperationCounts()).toEqual({ side_prompt: 1 });

    sidePrompt.finish();
    expect(getActiveOperationCounts()).toEqual({});
  });

  test("tracks active requests and waits for them before shutdown", async () => {
    resetOperationsForTest();
    let release!: () => void;
    const pending = trackActiveRequest(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    expect(getActiveRequestCount()).toBe(1);
    expect(await waitForDrain(10)).toBe(false);
    release();
    await pending;
    expect(await waitForDrain(10)).toBe(true);
  });

  test("marks the replica as draining", () => {
    resetOperationsForTest();
    beginDrain();
    expect(isDraining()).toBe(true);
  });

  test("returns a retryable draining response", async () => {
    resetOperationsForTest();
    beginDrain();

    const response = drainingResponse();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: "replica_draining", retry_after_seconds: 5 });
  });

  test("atomically rejects admission after drain starts", () => {
    resetOperationsForTest();
    const accepted = beginOperationIfAccepting("turn");
    expect(accepted.accepted).toBe(true);
    beginDrain();
    const rejected = beginOperationIfAccepting("subagent");
    expect(rejected).toEqual({ accepted: false });
    expect(getActiveOperationCounts()).toEqual({ turn: 1 });
    accepted.accepted && accepted.operation.finish();
  });
});
