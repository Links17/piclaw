/**
 * developer-settings.ts — Developer mode settings pane.
 */
import { html, useState, useCallback } from '../../vendor/preact-htm.js';
import { registerSettingsPane } from './pane-registry.js';
import { useTranslation } from '../../utils/i18n.js';

function getBool(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === 'true'; } catch { return fallback; }
}
function setBool(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { void e; } }
function getString(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function setString(key, value) { try { localStorage.setItem(key, value); } catch (e) { void e; } }

function DeveloperSettingsSection() {
    const { t } = useTranslation();
    const [devMode, setDevMode] = useState(() => getBool('piclaw_dev_mode', false));
    const [addonsCatalogUrl, setAddonsCatalogUrl] = useState(() => getString('piclaw_addons_catalog_url', ''));
    const [additionalCatalogUrls, setAdditionalCatalogUrls] = useState(() => getString('piclaw_addons_catalog_urls', ''));
    const [addonsRepoUrl, setAddonsRepoUrl] = useState(() => getString('piclaw_addons_repo_url', ''));
    const [debugSse, setDebugSse] = useState(() => getBool('piclaw_debug_sse', false));
    const [debugToolCalls, setDebugToolCalls] = useState(() => getBool('piclaw_debug_tool_calls', false));

    const toggleDev = useCallback(() => {
        const v = !devMode;
        setDevMode(v);
        setBool('piclaw_dev_mode', v);
    }, [devMode]);

    return html`
        <div class="settings-section">
            <h3>${t('settings.developer.heading')}</h3>
            <div class="settings-row">
                <label>${t('settings.developer.devMode')}</label>
                <input type="checkbox" checked=${devMode} onChange=${toggleDev} />
            </div>

            <p class="settings-hint settings-local-only-hint">${t('settings.developer.localHint')}</p>

            ${devMode && html`
                <h3 style="margin-top:16px">${t('settings.developer.addonSources')}</h3>
                <div class="settings-row">
                    <label>${t('settings.developer.catalogUrl')}</label>
                    <input type="text" value=${addonsCatalogUrl}
                        onInput=${e => { const v = e.target.value; setAddonsCatalogUrl(v); setString('piclaw_addons_catalog_url', v); }}
                        placeholder="https://raw.githubusercontent.com/.../catalog.json" style="max-width:400px" />
                </div>
                <p class="settings-hint" style="margin-top:0">${t('settings.developer.catalogHint')} (<code>rcarmo/piclaw-addons</code>).</p>
                <div class="settings-row" style="align-items:flex-start;">
                    <label>${t('settings.developer.additionalCatalogs')}</label>
                    <textarea
                        value=${additionalCatalogUrls}
                        onInput=${e => { const v = e.target.value; setAdditionalCatalogUrls(v); setString('piclaw_addons_catalog_urls', v); }}
                        placeholder="One URL per line\nhttps://example.com/catalog.json"
                        style="max-width:400px; min-height:86px; resize:vertical;"
                    ></textarea>
                </div>
                <p class="settings-hint" style="margin-top:0">${t('settings.developer.additionalHint')}</p>
                <div class="settings-row">
                    <label>${t('settings.developer.repoUrl')}</label>
                    <input type="text" value=${addonsRepoUrl}
                        onInput=${e => { const v = e.target.value; setAddonsRepoUrl(v); setString('piclaw_addons_repo_url', v); }}
                        placeholder="https://github.com/.../piclaw-addons.git" style="max-width:400px" />
                </div>
                <p class="settings-hint" style="margin-top:0">${t('settings.developer.repoHintPre')} <code>bun add</code> ${t('settings.developer.repoHintPost')}</p>

                <h3 style="margin-top:16px">${t('settings.developer.debug')}</h3>
                <div class="settings-row">
                    <label>${t('settings.developer.logSse')}</label>
                    <input type="checkbox" checked=${debugSse}
                        onChange=${() => { const v = !debugSse; setDebugSse(v); setBool('piclaw_debug_sse', v); }} />
                </div>
                <div class="settings-row">
                    <label>${t('settings.developer.logToolCalls')}</label>
                    <input type="checkbox" checked=${debugToolCalls}
                        onChange=${() => { const v = !debugToolCalls; setDebugToolCalls(v); setBool('piclaw_debug_tool_calls', v); }} />
                </div>
                <p class="settings-hint">${t('settings.developer.debugHint')}</p>
            `}
        </div>
    `;
}

const iconDev = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

registerSettingsPane({
    id: 'developer',
    label: 'Developer',
    icon: iconDev,
    component: DeveloperSettingsSection,
    order: 900,
});
