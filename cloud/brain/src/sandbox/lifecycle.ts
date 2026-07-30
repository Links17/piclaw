/** CubeSandbox platform state normalization for connect/resume FSM. */

export type SandboxPlatformState = "paused" | "running" | "unknown";

export function normalizeSandboxState(state?: string): SandboxPlatformState {
  const lower = (state ?? "").toLowerCase();
  if (lower === "paused") return "paused";
  if (lower === "launched" || lower === "running") return "running";
  return "unknown";
}

export function shouldAttemptResume(state?: string): boolean {
  return normalizeSandboxState(state) === "paused";
}

export function isRunningState(state?: string): boolean {
  return normalizeSandboxState(state) === "running";
}

/** After a failed resume, proceed only if control plane reports a running VM. */
export function shouldProceedAfterResumeFailure(refreshedState?: string): boolean {
  return isRunningState(refreshedState);
}
