
export function normalizeHandle(value) {
    const normalized = normalizeHandleName(value);
    return normalized ? `@${normalized}` : '';
}

export function normalizeHandleName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

export function getBranchHandleDraftState(value, currentValue = '') {
    const raw = String(value || '');
    const normalized = normalizeHandleName(raw);
    const currentNormalized = normalizeHandleName(currentValue);

    if (!raw.trim()) {
        return {
            normalized,
            handle: '',
            canSubmit: false,
            kind: 'error',
            message: 'Enter a branch handle.',
        };
    }

    if (!normalized) {
        return {
            normalized,
            handle: '',
            canSubmit: false,
            kind: 'error',
            message: 'Handle must contain at least one letter or number.',
        };
    }

    const handle = `@${normalized}`;
    if (normalized === currentNormalized) {
        return {
            normalized,
            handle,
            canSubmit: false,
            kind: 'info',
            message: `Already using ${handle}.`,
        };
    }

    if (normalized !== raw.trim()) {
        return {
            normalized,
            handle,
            canSubmit: true,
            kind: 'info',
            message: `Will save as ${handle}. Letters, numbers, - and _ are allowed; leading @ is optional.`,
        };
    }

    return {
        normalized,
        handle,
        canSubmit: true,
        kind: 'success',
        message: `Saving as ${handle}.`,
    };
}

/**
 * User-facing session title for sidebars, pickers, and toasts.
 */
export function formatSessionDisplayTitle(chat) {
    const agentName = typeof chat?.agent_name === 'string' ? chat.agent_name.trim() : '';
    if (agentName) return agentName;
    const title = typeof chat?.title === 'string' ? chat.title.trim() : '';
    if (title) return title;
    return 'New chat';
}

/**
 * Build the always-visible current branch label shown at the top of the session manager.
 */
export function formatCurrentBranchLabel(currentSessionAgent, currentChatJid) {
    void currentChatJid;
    return formatSessionDisplayTitle(currentSessionAgent);
}

/**
 * Return the lifecycle badges that should appear for a branch in picker/session surfaces.
 */
export function getBranchLifecycleBadges(chat, options = {}) {
    const badges = [];
    const currentChatJid = typeof options.currentChatJid === 'string' ? options.currentChatJid.trim() : '';
    const chatJid = typeof chat?.chat_jid === 'string' ? chat.chat_jid.trim() : '';
    if (currentChatJid && chatJid === currentChatJid) {
        badges.push('current');
    }
    if (chat?.archived_at) {
        badges.push('archived');
    } else {
        if (chat?.is_compacting || chat?.activity_status === 'compacting') badges.push('compacting');
        if (chat?.is_active) badges.push('active');
    }
    return badges;
}

/**
 * Build the branch row identity without lifecycle badges for rich picker rendering.
 */
export function formatBranchPickerBaseLabel(chat) {
    return formatSessionDisplayTitle(chat);
}

/**
 * Build the branch row label for the session manager popup.
 */
export function formatBranchPickerLabel(chat, options = {}) {
    void options;
    return formatBranchPickerBaseLabel(chat);
}

/**
 * Describe the user-facing restore result, including collision suffixing when the restored handle changes.
 */
export function describeBranchRestoreResult(previousAgentName, restoredAgentName, fallbackChatJid) {
    const previousHandle = normalizeHandle(previousAgentName);
    const restoredHandle = normalizeHandle(restoredAgentName);
    const fallback = String(fallbackChatJid || '').trim();

    if (previousHandle && restoredHandle && previousHandle !== restoredHandle) {
        return `Restored archived ${previousHandle} as ${restoredHandle} because ${previousHandle} is already in use.`;
    }

    if (restoredHandle) {
        return `Restored ${restoredHandle}.`;
    }

    if (previousHandle) {
        return `Restored ${previousHandle}.`;
    }

    return `Restored ${fallback || 'branch'}.`;
}
