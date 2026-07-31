import { saveUiState } from '../api.js';
import { getLocalStorageBoolean, setLocalStorageItem } from '../utils/storage.js';

export const METERS_STORAGE_KEY = 'piclaw_system_meters_enabled';
export const METERS_COLLAPSED_STORAGE_KEY = 'piclaw_system_meters_collapsed';
export const METERS_EVENT_NAME = 'piclaw-meters-change';
export const METERS_COLLAPSED_EVENT_NAME = 'piclaw-meters-collapsed-change';

function dispatchMetersChange(enabled) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(METERS_EVENT_NAME, {
        detail: { enabled: Boolean(enabled) },
    }));
}

function persistMetersState(patch) {
    if (typeof fetch !== 'function') return;
    void saveUiState({ ui_meters: patch }).catch((error) => {
        console.debug('[meters] Failed to persist meters UI state.', error);
    });
}

function dispatchMetersCollapsedChange(collapsed) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(METERS_COLLAPSED_EVENT_NAME, {
        detail: { collapsed: Boolean(collapsed) },
    }));
}

export function readStoredMetersEnabled(defaultValue = false) {
    return getLocalStorageBoolean(METERS_STORAGE_KEY, defaultValue);
}

export function readStoredMetersCollapsed(defaultValue = false) {
    return getLocalStorageBoolean(METERS_COLLAPSED_STORAGE_KEY, defaultValue);
}

export function applyMetersEnabled(enabled, options: { persist?: boolean; persistServer?: boolean } = {}) {
    const persist = options.persist !== false;
    const persistServer = options.persistServer !== false;
    const next = Boolean(enabled);
    if (persist) {
        setLocalStorageItem(METERS_STORAGE_KEY, next ? 'true' : 'false');
    }
    if (persistServer) persistMetersState({ enabled: next });
    dispatchMetersChange(next);
    return next;
}

export function toggleMetersEnabled() {
    const next = !readStoredMetersEnabled(false);
    return applyMetersEnabled(next);
}

export function applyMetersCollapsed(collapsed, options: { persist?: boolean; persistServer?: boolean } = {}) {
    const persist = options.persist !== false;
    const persistServer = options.persistServer !== false;
    const next = Boolean(collapsed);
    if (persist) {
        setLocalStorageItem(METERS_COLLAPSED_STORAGE_KEY, next ? 'true' : 'false');
    }
    if (persistServer) persistMetersState({ collapsed: next });
    dispatchMetersCollapsedChange(next);
    return next;
}

export function toggleMetersCollapsed() {
    const next = !readStoredMetersCollapsed(false);
    return applyMetersCollapsed(next);
}

export function applyMetersFromEvent(payload) {
    const mode = typeof payload?.mode === 'string' ? payload.mode.trim().toLowerCase() : '';
    if (typeof payload?.enabled === 'boolean') {
        applyMetersEnabled(Boolean(payload.enabled), { persistServer: false });
    } else if (mode === 'toggle') {
        const next = !readStoredMetersEnabled(false);
        applyMetersEnabled(next, { persistServer: false });
    }
    if (typeof payload?.collapsed === 'boolean') {
        applyMetersCollapsed(Boolean(payload.collapsed), { persistServer: false });
    }
}
