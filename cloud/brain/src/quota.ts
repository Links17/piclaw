/** Quota enforcement errors — surfaced as HTTP 429 with structured body. */
export type QuotaCode = "daily_tokens" | "active_sandboxes";

export class QuotaExceededError extends Error {
  readonly code: QuotaCode;
  readonly limit: number;
  readonly used: number;

  constructor(code: QuotaCode, limit: number, used: number) {
    super(
      code === "daily_tokens"
        ? "daily token quota exceeded"
        : "active sandbox quota exceeded",
    );
    this.name = "QuotaExceededError";
    this.code = code;
    this.limit = limit;
    this.used = used;
  }

  toJson(): Record<string, unknown> {
    return {
      error: "quota_exceeded",
      code: this.code,
      limit: this.limit,
      used: this.used,
      message: this.message,
    };
  }
}

export function quotaErrorFromMessage(message: string): QuotaExceededError | null {
  if (message.includes("daily token quota")) {
    return new QuotaExceededError("daily_tokens", 0, 0);
  }
  if (message.includes("active sandbox quota")) {
    return new QuotaExceededError("active_sandboxes", 0, 0);
  }
  return null;
}

export function estimateProviderTokenBudget(input: {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  dailyLimit?: number;
}): number {
  const conservative = Math.max(
    1,
    Math.ceil(input.estimatedInputTokens) + Math.max(1, input.maxOutputTokens),
  );
  // Tiny test/development limits must still permit one request. The DB
  // reservation serializes that request; actual settlement can exceed the
  // estimate and blocks subsequent calls.
  return input.dailyLimit && input.dailyLimit > 1
    ? Math.min(conservative, Math.max(1, Math.floor(input.dailyLimit * 0.9)))
    : conservative;
}
