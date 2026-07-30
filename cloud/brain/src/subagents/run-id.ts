/** Normalize subagent run ids — empty/whitespace resume values must not become PK "". */
export function normalizeSubagentRunId(value?: string | null): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function allocateSubagentRunId(existing?: string | null): string {
  return normalizeSubagentRunId(existing) ?? `run-${crypto.randomUUID()}`;
}
