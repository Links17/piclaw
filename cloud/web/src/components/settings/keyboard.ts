import { html, useEffect, useMemo, useState } from '../../vendor/preact-htm.js';
import {
    KEYBOARD_SHORTCUT_ACTIONS,
    formatShortcutBindingList,
    getKeyboardShortcutBindings,
    normalizeShortcutBindingString,
    parseShortcutBindingList,
    readAllKeyboardShortcutBindings,
    resetKeyboardShortcutBindings,
    saveKeyboardShortcutBindings,
} from '../../ui/keyboard-shortcuts.js';
import { useTranslation } from '../../utils/i18n.js';

function hasFilterMatch(filter, action, bindingsText) {
    const query = String(filter || '').trim().toLowerCase();
    if (!query) return true;
    return [action.label, action.description, bindingsText, ...(action.defaultBindings || [])]
        .some((part) => String(part || '').toLowerCase().includes(query));
}

export function KeyboardSection({ filter = '', setStatus }) {
    const { t } = useTranslation();
    const [drafts, setDrafts] = useState(() => {
        const current = readAllKeyboardShortcutBindings();
        return Object.fromEntries(Object.entries(current).map(([id, bindings]) => [id, formatShortcutBindingList(bindings)]));
    });

    useEffect(() => {
        const sync = () => {
            const current = readAllKeyboardShortcutBindings();
            setDrafts(Object.fromEntries(Object.entries(current).map(([id, bindings]) => [id, formatShortcutBindingList(bindings)])));
        };
        window.addEventListener('piclaw:keyboard-shortcuts-changed', sync);
        return () => window.removeEventListener('piclaw:keyboard-shortcuts-changed', sync);
    }, []);

    const visibleActions = useMemo(() => KEYBOARD_SHORTCUT_ACTIONS.filter((action) => {
        const bindingsText = String(drafts[action.id] || '');
        return hasFilterMatch(filter, action, bindingsText);
    }), [drafts, filter]);

    const saveAction = (actionId) => {
        const raw = String(drafts[actionId] || '').trim();
        const tokens = raw ? raw.split(/[\n,]/).map((part) => part.trim()).filter(Boolean) : [];
        const invalid = tokens.filter((token) => !normalizeShortcutBindingString(token));
        if (invalid.length > 0) {
            setStatus?.(t('settings.keyboard.invalidShortcut', { token: invalid[0] }), 'error');
            return;
        }
        const bindings = parseShortcutBindingList(raw);
        saveKeyboardShortcutBindings(actionId, bindings);
        setDrafts((prev) => ({ ...prev, [actionId]: formatShortcutBindingList(getKeyboardShortcutBindings(actionId)) }));
        setStatus?.(t('settings.keyboard.saved'), 'success');
    };

    const resetAction = (actionId) => {
        resetKeyboardShortcutBindings(actionId);
        setDrafts((prev) => ({ ...prev, [actionId]: formatShortcutBindingList(getKeyboardShortcutBindings(actionId)) }));
        setStatus?.(t('settings.keyboard.resetOne'), 'success');
    };

    const resetAll = () => {
        resetKeyboardShortcutBindings();
        const current = readAllKeyboardShortcutBindings();
        setDrafts(Object.fromEntries(Object.entries(current).map(([id, bindings]) => [id, formatShortcutBindingList(bindings)])));
        setStatus?.(t('settings.keyboard.resetAllDone'), 'success');
    };

    return html`
        <div class="settings-section">
            <h3>${t('settings.keyboard.heading')}</h3>
            <p class="settings-hint">
                ${t('settings.keyboard.hint1')}
                <code>Escape</code> ${t('settings.keyboard.hint1b')}
            </p>
            <p class="settings-hint">
                <code>/help</code> ${t('settings.keyboard.hint2mid')} <code>"</code> ${t('settings.keyboard.hint2end')}
            </p>

            <div class="settings-row" style="align-items:center; gap:10px; margin-bottom:18px; justify-content:flex-end;">
                <button class="settings-addon-btn" style="min-width:180px; height:40px; font-size:14px;" onClick=${resetAll}>${t('settings.keyboard.resetAll')}</button>
            </div>

            <div class="settings-shortcut-list" style="display:grid; gap:16px;">
                ${visibleActions.map((action) => html`
                    <div class="settings-shortcut-card" key=${action.id} style="display:grid; grid-template-columns:minmax(240px, 1.25fr) minmax(320px, 1fr); gap:18px; align-items:start; padding:18px 20px; border:1px solid var(--border-color, rgba(120,120,120,.22)); border-radius:16px; background:var(--panel-bg, rgba(255,255,255,.04));">
                        <div class="settings-shortcut-copy" style="min-width:0;">
                            <div class="settings-shortcut-title" style="font-size:17px; font-weight:700; line-height:1.3;">${action.label}</div>
                            <div class="settings-hint" style="margin:6px 0 0 0; font-size:14px; line-height:1.5;">${action.description}</div>
                            <div class="settings-shortcut-default" style="margin-top:10px; font-size:13px; color:var(--text-secondary);">${t('settings.keyboard.defaultColon')} <code style="font-size:13px;">${formatShortcutBindingList(action.defaultBindings)}</code></div>
                        </div>
                        <div class="settings-shortcut-controls" style="display:grid; gap:10px; min-width:0;">
                            <input
                                type="text"
                                value=${drafts[action.id] || ''}
                                placeholder=${formatShortcutBindingList(action.defaultBindings)}
                                onInput=${(e) => setDrafts((prev) => ({ ...prev, [action.id]: e.target.value }))}
                                style="width:100%; min-height:46px; padding:10px 14px; font-size:16px; line-height:1.35; font-family:var(--font-mono, ui-monospace, monospace); border-radius:12px;"
                            />
                            <div class="settings-shortcut-actions" style="display:flex; justify-content:flex-end; align-items:center; gap:10px; flex-wrap:wrap;">
                                <button class="settings-addon-btn settings-addon-btn-install" style="min-width:96px; height:40px; font-size:14px;" onClick=${() => saveAction(action.id)}>${t('settings.keyboard.save')}</button>
                                <button class="settings-addon-btn" style="min-width:96px; height:40px; font-size:14px;" onClick=${() => resetAction(action.id)}>${t('settings.keyboard.defaultBtn')}</button>
                            </div>
                        </div>
                    </div>
                `)}
                ${visibleActions.length === 0 && html`<div class="settings-hint">${t('settings.keyboard.noMatch')}</div>`}
            </div>
        </div>
    `;
}
