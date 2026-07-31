import { normalizeSandboxWorkspacePath } from './workspace-visibility.js';

export function buildWorkspaceUpdateDetailFromPaths(paths: unknown): { updates: Array<{ path: string; truncated: boolean }> } {
  const updates: Array<{ path: string; truncated: boolean }> = [];
  if (!Array.isArray(paths)) return { updates };

  for (const entry of paths) {
    const normalized = normalizeSandboxWorkspacePath(entry);
    if (!normalized) continue;
    updates.push({ path: normalized, truncated: true });
  }
  return { updates };
}

export function dispatchWorkspaceUpdateEvent(detail: { updates?: unknown[] }): void {
  if (typeof window === 'undefined') return;
  if (!Array.isArray(detail?.updates) || detail.updates.length === 0) return;
  window.dispatchEvent(new CustomEvent('workspace-update', { detail }));
}
