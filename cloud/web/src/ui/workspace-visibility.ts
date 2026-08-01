import { isCloudWebBuild } from './chat-jid.js';

export const LEGACY_WORKSPACE_OPEN_STORAGE_KEY = 'workspaceOpen';
export const DESKTOP_WORKSPACE_OPEN_STORAGE_KEY = 'workspaceOpen.desktop';
export const NARROW_WORKSPACE_OPEN_STORAGE_KEY = 'workspaceOpen.narrow';
export const DESKTOP_WORKSPACE_LAYOUT_MEDIA_QUERY = '(min-width: 1024px) and (orientation: landscape)';

export type WorkspaceLayoutBucket = 'desktop' | 'narrow';

function getRuntimeWindow(runtime: any = typeof window !== 'undefined' ? window : null) {
  return runtime && typeof runtime === 'object' ? runtime : null;
}

function readRuntimeStorageBoolean(runtime: any, key: string): boolean | null {
  const runtimeWindow = getRuntimeWindow(runtime);
  if (!runtimeWindow?.localStorage?.getItem) return null;
  try {
    const raw = runtimeWindow.localStorage.getItem(key);
    if (raw === null) return null;
    return raw === 'true';
  } catch {
    return null;
  }
}

function writeRuntimeStorageBoolean(runtime: any, key: string, value: boolean): void {
  const runtimeWindow = getRuntimeWindow(runtime);
  if (!runtimeWindow?.localStorage?.setItem) return;
  try {
    runtimeWindow.localStorage.setItem(key, String(Boolean(value)));
  } catch {
    return;
  }
}

export function resolveWorkspaceLayoutBucket(runtime: any = typeof window !== 'undefined' ? window : null): WorkspaceLayoutBucket {
  const runtimeWindow = getRuntimeWindow(runtime);
  if (!runtimeWindow?.matchMedia) return 'desktop';
  return runtimeWindow.matchMedia(DESKTOP_WORKSPACE_LAYOUT_MEDIA_QUERY).matches ? 'desktop' : 'narrow';
}

export function getWorkspaceOpenStorageKey(bucket: WorkspaceLayoutBucket | null | undefined): string {
  return bucket === 'narrow' ? NARROW_WORKSPACE_OPEN_STORAGE_KEY : DESKTOP_WORKSPACE_OPEN_STORAGE_KEY;
}

export function readStoredWorkspaceOpenPreference(options: {
  runtime?: any;
  bucket?: WorkspaceLayoutBucket | null;
  allowLegacyFallback?: boolean;
  defaultValue?: boolean;
} = {}): boolean {
  const {
    runtime = typeof window !== 'undefined' ? window : null,
    bucket = null,
    allowLegacyFallback = false,
    defaultValue = false,
  } = options;

  const targetBucket = bucket || resolveWorkspaceLayoutBucket(runtime);
  const storageKey = getWorkspaceOpenStorageKey(targetBucket);
  const scopedValue = readRuntimeStorageBoolean(runtime, storageKey);
  if (typeof scopedValue === 'boolean') return scopedValue;

  if (allowLegacyFallback && targetBucket === 'desktop') {
    const legacyValue = readRuntimeStorageBoolean(runtime, LEGACY_WORKSPACE_OPEN_STORAGE_KEY);
    if (typeof legacyValue === 'boolean') return legacyValue;
  }

  return defaultValue;
}

export function persistWorkspaceOpenPreference(
  workspaceOpen: boolean,
  options: { runtime?: any; bucket?: WorkspaceLayoutBucket | null } = {},
): void {
  const {
    runtime = typeof window !== 'undefined' ? window : null,
    bucket = null,
  } = options;
  const targetBucket = bucket || resolveWorkspaceLayoutBucket(runtime);
  writeRuntimeStorageBoolean(runtime, getWorkspaceOpenStorageKey(targetBucket), Boolean(workspaceOpen));
}

/** Cloud web only exposes workspace UI once the session has a sandbox binding. */
export function sessionHasWorkspace(
  chat: { sandbox_id?: string | null } | null | undefined,
  options: { cloudBuild?: boolean } = {},
): boolean {
  const cloudBuild = options.cloudBuild ?? isCloudWebBuild();
  if (!cloudBuild) return true;
  const sandboxId = typeof chat?.sandbox_id === 'string' ? chat.sandbox_id.trim() : '';
  return sandboxId.length > 0;
}

/** Cloud web hides terminal/VNC entry points; local runtime keeps them. */
export function remoteAccessTabsAvailable(options: { cloudBuild?: boolean } = {}): boolean {
  const cloudBuild = options.cloudBuild ?? isCloudWebBuild();
  return !cloudBuild;
}

/** Normalize sandbox absolute paths to workspace-relative editor paths. */
export function normalizeSandboxWorkspacePath(raw: unknown): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  if (trimmed.startsWith('/workspace/')) return trimmed.slice('/workspace/'.length);
  if (trimmed === '/workspace' || trimmed === '.') return null;
  if (trimmed.startsWith('/') || trimmed.includes('://')) return null;
  if (trimmed === '..' || trimmed.startsWith('../')) return null;
  return trimmed;
}

export function shouldAutoRevealWorkspaceForSandboxBinding(
  previousSandboxId: string | null | undefined,
  nextSandboxId: string | null | undefined,
): boolean {
  const prev = typeof previousSandboxId === 'string' ? previousSandboxId.trim() : '';
  const next = typeof nextSandboxId === 'string' ? nextSandboxId.trim() : '';
  return Boolean(next) && next !== prev;
}

export function resolveWorkspaceAvailable(
  chat: { sandbox_id?: string | null } | null | undefined,
  options: { cloudBuild?: boolean; probeAvailable?: boolean } = {},
): boolean {
  if (sessionHasWorkspace(chat, options)) return true;
  const cloudBuild = options.cloudBuild ?? isCloudWebBuild();
  if (!cloudBuild) return true;
  return Boolean(options.probeAvailable);
}

export function shouldAutoRevealWorkspaceOnAvailabilityChange(
  previousAvailable: boolean,
  nextAvailable: boolean,
): boolean {
  return !previousAvailable && nextAvailable;
}

export function inferWorkspaceAvailableFromIndexStatus(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return typeof record.has_sandbox === 'boolean' ? record.has_sandbox : false;
}

export function createRevealWorkspacePanelAction(options: {
  setWorkspaceOpen: (open: boolean) => void;
  setWorkspaceProbeAvailable?: (available: boolean) => void;
}): () => void {
  return () => {
    options.setWorkspaceProbeAvailable?.(true);
    options.setWorkspaceOpen(true);
  };
}
