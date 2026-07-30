import { describe, expect, it } from "bun:test";
import {
  isRunningState,
  normalizeSandboxState,
  shouldAttemptResume,
  shouldProceedAfterResumeFailure,
} from "./lifecycle.ts";

describe("sandbox lifecycle FSM", () => {
  it("normalizes platform states", () => {
    expect(normalizeSandboxState("paused")).toBe("paused");
    expect(normalizeSandboxState("launched")).toBe("running");
    expect(normalizeSandboxState("running")).toBe("running");
    expect(normalizeSandboxState("")).toBe("unknown");
  });

  it("only resumes paused sandboxes", () => {
    expect(shouldAttemptResume("paused")).toBe(true);
    expect(shouldAttemptResume("launched")).toBe(false);
    expect(shouldAttemptResume("running")).toBe(false);
  });

  it("reconciles resume failure when control plane reports running", () => {
    expect(shouldProceedAfterResumeFailure("launched")).toBe(true);
    expect(shouldProceedAfterResumeFailure("running")).toBe(true);
    expect(shouldProceedAfterResumeFailure("paused")).toBe(false);
    expect(isRunningState("launched")).toBe(true);
  });
});
