export type SandboxUnavailableCode = "not_found" | "resume_failed" | "unreachable" | "platform_error";

export class SandboxUnavailableError extends Error {
  readonly sandboxId: string;
  readonly code: SandboxUnavailableCode;
  readonly detail: string;

  constructor(sandboxId: string, code: SandboxUnavailableCode, detail: string) {
    super(`sandbox unavailable (${code}): ${detail}`);
    this.name = "SandboxUnavailableError";
    this.sandboxId = sandboxId;
    this.code = code;
    this.detail = detail;
  }
}
