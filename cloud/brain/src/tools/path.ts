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

/** Strip /workspace prefix for Web UI relative paths. */
export function workspaceRelativePath(absPath: string): string {
  const normalized = absPath.replace(/\/+/g, "/");
  if (normalized === WORKSPACE_ROOT) return ".";
  if (normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    return normalized.slice(WORKSPACE_ROOT.length + 1);
  }
  return normalized;
}

export { WORKSPACE_ROOT };
