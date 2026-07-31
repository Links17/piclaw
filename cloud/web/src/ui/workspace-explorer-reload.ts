export type WorkspaceReloadAction =
  | { kind: 'root' }
  | { kind: 'subtree'; path: string };

/** Map a truncated workspace_update path to the tree reload target. */
export function resolveWorkspaceReloadTarget(rawPath: unknown): WorkspaceReloadAction {
  const path = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!path || path === '.') return { kind: 'root' };
  if (!path.includes('/')) return { kind: 'root' };
  const parent = path.split('/').slice(0, -1).join('/');
  return { kind: 'subtree', path: parent || '.' };
}

export function applyTruncatedWorkspaceReloads(
  updates: unknown,
  handlers: {
    loadTree: () => void;
    loadSubtree: (path: string) => void;
    clearRootSignature?: () => void;
  },
): void {
  if (!Array.isArray(updates)) return;

  const reloadRoot = () => {
    handlers.clearRootSignature?.();
    handlers.loadTree();
  };

  for (const update of updates) {
    if (!update || typeof update !== 'object' || !(update as { truncated?: boolean }).truncated) continue;
    const target = resolveWorkspaceReloadTarget((update as { path?: unknown }).path);
    if (target.kind === 'root') {
      reloadRoot();
    } else if (target.path === '.') {
      reloadRoot();
    } else {
      handlers.loadSubtree(target.path);
    }
  }
}
