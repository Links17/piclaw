export type SessionRecordingMode = "metadata" | "redacted" | "full";

export interface SessionRecordingRedactionOptions {
  patterns?: string[];
  keys?: string[];
  maxStringLength?: number;
}

const SECRET_KEY_PATTERN = /(?:secret|token|password|authorization|api[_-]?key|access[_-]?key|refresh[_-]?token|private[_-]?key|credential|cookie|session|set-cookie|x-api-key|passphrase)/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "[redacted-authorization]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]"],
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[redacted-secret-like]"],
  [/data:[^;\s]+;base64,[A-Za-z0-9+/=]{64,}/gi, "[redacted-data-url]"],
];
const DEFAULT_MAX_REDACTED_STRING_LENGTH = 12_000;

function normalizeRedactionOptions(value: unknown): SessionRecordingRedactionOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const patterns = Array.isArray(record.patterns)
    ? record.patterns.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : undefined;
  const keys = Array.isArray(record.keys)
    ? record.keys.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 50)
    : undefined;
  const maxStringLength = Number(record.maxStringLength ?? record.max_string_length);
  const normalized: SessionRecordingRedactionOptions = {};
  if (patterns?.length) normalized.patterns = patterns;
  if (keys?.length) normalized.keys = keys;
  if (Number.isFinite(maxStringLength)) {
    normalized.maxStringLength = Math.min(128_000, Math.max(256, Math.round(maxStringLength)));
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function customKeyMatches(key: string, redaction?: SessionRecordingRedactionOptions): boolean {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return false;
  return Boolean(redaction?.keys?.some((candidate) => candidate.toLowerCase() === normalized));
}

function redactString(
  value: string,
  redactions: string[],
  redaction?: SessionRecordingRedactionOptions,
): string {
  let next = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    if (pattern.test(next)) {
      pattern.lastIndex = 0;
      redactions.push(replacement.slice(1, -1));
      next = next.replace(pattern, replacement);
    }
  }
  for (const source of redaction?.patterns || []) {
    try {
      const pattern = new RegExp(source, "g");
      if (pattern.test(next)) {
        pattern.lastIndex = 0;
        redactions.push("custom-pattern");
        next = next.replace(pattern, "[redacted-custom]");
      }
    } catch {
      redactions.push("invalid-custom-pattern");
    }
  }
  const maxLength = redaction?.maxStringLength || DEFAULT_MAX_REDACTED_STRING_LENGTH;
  if (next.length > maxLength) {
    redactions.push("truncated-string");
    next = `${next.slice(0, maxLength)}\n[truncated ${next.length - maxLength} chars]`;
  }
  return next;
}

export function sanitizeForRecording(
  value: unknown,
  mode: SessionRecordingMode,
  redactions: string[],
  key = "",
  redaction?: SessionRecordingRedactionOptions,
): unknown {
  if (mode === "full") return value;
  if (mode === "metadata") {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return { type: "string", length: value.length };
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return { type: "array", length: value.length };
    if (typeof value === "object") {
      return { type: "object", keys: Object.keys(value as Record<string, unknown>).sort() };
    }
    return String(typeof value);
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(key) || customKeyMatches(key, redaction)) {
      redactions.push(`key:${key}`);
      return "[redacted]";
    }
    return redactString(value, redactions, redaction);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForRecording(item, mode, redactions, key, redaction));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[entryKey] = sanitizeForRecording(entryValue, mode, redactions, entryKey, redaction);
    }
    return out;
  }
  return String(value);
}

export function previewSessionRecordingRedaction(
  payload: unknown,
  options: { mode?: unknown; redaction?: unknown } = {},
): { data: unknown; redactions: string[] } {
  const mode = options.mode === "metadata" || options.mode === "full" || options.mode === "redacted"
    ? options.mode
    : "redacted";
  const redactions: string[] = [];
  const data = sanitizeForRecording(
    payload,
    mode,
    redactions,
    "",
    normalizeRedactionOptions(options.redaction),
  );
  return { data, redactions: Array.from(new Set(redactions)) };
}

export { normalizeRedactionOptions };
