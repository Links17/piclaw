import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { consumeRequestedSettingsOpenState, normalizeSettingsSectionId, requestOpenSettingsDialog } from './settings-dialog-events.js';

export function openSettingsDialog(options = {}) {
    requestOpenSettingsDialog(options);
}

export function preloadSettingsDialog() {
    return Promise.resolve();
}

export function SettingsDialogLoader() {
    const [open, setOpen] = useState(false);
    const [Content, setContent] = useState(null);

    useEffect(() => {
        const handler = (event) => {
            const section = normalizeSettingsSectionId(event?.detail?.section);
            if (section) {
                try { window.__piclawSettingsRequestedSection = section; } catch (e) { void e; }
            }
            setOpen(true);
        };
        window.addEventListener('piclaw:open-settings', handler);
        const pending = consumeRequestedSettingsOpenState();
        if (pending.open) {
            if (pending.section) {
                try { window.__piclawSettingsRequestedSection = pending.section; } catch (e) { void e; }
            }
            setOpen(true);
        }
        return () => window.removeEventListener('piclaw:open-settings', handler);
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    useEffect(() => {
        import('./settings-dialog.js').then(mod => {
            setContent(() => mod.SettingsDialogContent);
        });
    }, []);

    if (!open) return null;

    if (!Content) {
        return html`
            <div class="settings-dialog-backdrop" onClick=${() => setOpen(false)}>
                <div class="settings-dialog settings-dialog-loading-shell" data-testid="settings-dialog">
                    <div class="settings-loading-shell-body">
                        <span class="settings-spinner"></span>
                        <span>Loading settings…</span>
                    </div>
                </div>
            </div>
        `;
    }

    return html`<${Content} onClose=${() => setOpen(false)} />`;
}
