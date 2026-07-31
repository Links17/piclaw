import { cubeFetch } from "./auth.ts";
import { WORKSPACE_ROOT } from "../tools/path.ts";

function parseVolumeId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid volume create response");
  }
  const record = payload as Record<string, unknown>;
  const candidates = [record.volumeID, record.volumeId, record.volume_id, record.id];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed) return trimmed;
  }
  throw new Error("volume create response missing volume id");
}

export function volumeNameForSession(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const base = sanitized || "session";
  return base.slice(0, 128);
}

export async function createWorkspaceVolume(sessionId: string): Promise<string> {
  const res = await cubeFetch("/volumes", {
    method: "POST",
    body: JSON.stringify({ name: volumeNameForSession(sessionId) }),
  });
  if (!res.ok) {
    throw new Error(`POST /volumes → ${res.status}: ${await res.text()}`);
  }
  return parseVolumeId(await res.json());
}

export async function deleteWorkspaceVolume(volumeId: string): Promise<boolean> {
  const trimmed = typeof volumeId === "string" ? volumeId.trim() : "";
  if (!trimmed) return false;
  const res = await cubeFetch(`/volumes/${encodeURIComponent(trimmed)}`, { method: "DELETE" });
  return res.ok || res.status === 404;
}

export function buildWorkspaceVolumeMounts(volumeId: string): Array<{ name: string; path: string }> {
  return [{ name: volumeId, path: WORKSPACE_ROOT }];
}
