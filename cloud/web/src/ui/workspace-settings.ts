import { getLocalStorageNumber, setLocalStorageItem } from '../utils/storage.js';

export const WORKSPACE_CLIENT_SETTINGS_EVENT = 'piclaw:workspace-client-settings-updated';
export const WORKSPACE_REFRESH_INTERVAL_STORAGE_KEY = 'workspaceRefreshIntervalSec';
export const WORKSPACE_FOLDER_PREVIEW_DEPTH_STORAGE_KEY = 'workspaceFolderPreviewDepth';
export const DEFAULT_WORKSPACE_REFRESH_INTERVAL_SEC = 60;
export const DEFAULT_WORKSPACE_FOLDER_PREVIEW_DEPTH = 3;

export interface WorkspaceClientSettings {
    refreshIntervalSec: number;
    folderPreviewDepth: number;
}

export function clampWorkspaceRefreshIntervalSec(value, fallback = DEFAULT_WORKSPACE_REFRESH_INTERVAL_SEC) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(300, Math.max(15, Math.round(parsed)));
}

export function clampWorkspaceFolderPreviewDepth(value, fallback = DEFAULT_WORKSPACE_FOLDER_PREVIEW_DEPTH) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(8, Math.max(0, Math.round(parsed)));
}

export function readWorkspaceClientSettings(): WorkspaceClientSettings {
    return {
        refreshIntervalSec: clampWorkspaceRefreshIntervalSec(
            getLocalStorageNumber(WORKSPACE_REFRESH_INTERVAL_STORAGE_KEY, DEFAULT_WORKSPACE_REFRESH_INTERVAL_SEC),
            DEFAULT_WORKSPACE_REFRESH_INTERVAL_SEC,
        ),
        folderPreviewDepth: clampWorkspaceFolderPreviewDepth(
            getLocalStorageNumber(WORKSPACE_FOLDER_PREVIEW_DEPTH_STORAGE_KEY, DEFAULT_WORKSPACE_FOLDER_PREVIEW_DEPTH),
            DEFAULT_WORKSPACE_FOLDER_PREVIEW_DEPTH,
        ),
    };
}

export function applyWorkspaceClientSettings(patch: Partial<WorkspaceClientSettings> = {}): WorkspaceClientSettings {
    const current = readWorkspaceClientSettings();
    const next = {
        refreshIntervalSec: clampWorkspaceRefreshIntervalSec(
            Object.prototype.hasOwnProperty.call(patch, 'refreshIntervalSec') ? patch.refreshIntervalSec : current.refreshIntervalSec,
            current.refreshIntervalSec,
        ),
        folderPreviewDepth: clampWorkspaceFolderPreviewDepth(
            Object.prototype.hasOwnProperty.call(patch, 'folderPreviewDepth') ? patch.folderPreviewDepth : current.folderPreviewDepth,
            current.folderPreviewDepth,
        ),
    };

    setLocalStorageItem(WORKSPACE_REFRESH_INTERVAL_STORAGE_KEY, String(next.refreshIntervalSec));
    setLocalStorageItem(WORKSPACE_FOLDER_PREVIEW_DEPTH_STORAGE_KEY, String(next.folderPreviewDepth));

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(WORKSPACE_CLIENT_SETTINGS_EVENT, { detail: { settings: next } }));
    }

    return next;
}
