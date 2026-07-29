const WORKSPACE_ROOT = "/workspace";

/** Normalize and validate sandbox file paths — must stay under /workspace. */
export function resolveWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("path is required");
  const normalized = trimmed.startsWith("/") ? trimmed : `${WORKSPACE_ROOT}/${trimmed}`;
  if (!normalized.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`path must be under ${WORKSPACE_ROOT}`);
  }
  if (normalized.includes("..")) {
    throw new Error("path must not contain ..");
  }
  return normalized.replace(/\/+/g, "/");
}

export { WORKSPACE_ROOT };
