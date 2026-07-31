import { config } from "../config.ts";
import { publish } from "../events.ts";
import { resolveWorkspacePath, workspaceRelativePath } from "../tools/path.ts";

export async function publishWorkspaceUpdate(sessionId: string, rawPath: string): Promise<void> {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === ".") return;
  const absPath = resolveWorkspacePath(trimmed);
  await publish(sessionId, {
    type: "workspace_update",
    path: workspaceRelativePath(absPath),
    replica: config.replicaId,
  });
}

export async function publishWorkspaceUpdates(sessionId: string, paths: unknown): Promise<void> {
  if (!Array.isArray(paths)) return;
  for (const entry of paths) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (!trimmed) continue;
    try {
      await publishWorkspaceUpdate(sessionId, trimmed);
    } catch {
      // best-effort per artifact path
    }
  }
}
