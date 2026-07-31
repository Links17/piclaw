import { html, useState, useEffect, useCallback, useMemo } from '../../vendor/preact-htm.js';
import { t, useTranslation } from '../../utils/i18n.js';
import {
    deleteSessionRecording,
    getSessionRecording,
    getSessionRecordings,
    previewSessionRecordingRedaction,
    sessionRecordingExportUrl,
    sessionRecordingPlaybackUrl,
    startSessionRecording,
    stopSessionRecording,
} from '../../api.js';

function formatDateTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function modeLabel(mode) {
    if (mode === 'full') return t('settings.recordings.modeFull');
    if (mode === 'metadata') return t('settings.recordings.modeMetadata');
    return t('settings.recordings.modeRedacted');
}

function RecordingPill({ children, type = 'neutral' }) {
    return html`<span class=${`settings-task-pill settings-task-pill-${type}`}>${children}</span>`;
}

function readCurrentChatJid() {
    if (typeof window === 'undefined') return 'web:default';
    return String((window as any).__piclawCurrentChatJid || 'web:default');
}

function parseList(value) {
    return String(value || '').split('\n').map(item => item.trim()).filter(Boolean);
}

function RecordingDetail({ recording, details, onDelete, onRefresh }) {
    const { t: tr } = useTranslation();
    if (!recording) return html`<div class="settings-task-detail-empty">${tr('settings.recordings.selectPrompt')}</div>`;
    const meta = details?.meta || recording;
    const events = Array.isArray(details?.events) ? details.events : [];
    const redactionCount = events.reduce((count, event) => count + (Array.isArray(event.redactions) ? event.redactions.length : 0), 0);
    const eventKinds = events.reduce((map, event) => {
        const key = event.kind || 'event';
        map[key] = (map[key] || 0) + 1;
        return map;
    }, {});
    return html`
        <div class="settings-task-detail settings-recording-detail">
            <div class="settings-task-detail-header">
                <div>
                    <h4>${meta.title || meta.id}</h4>
                    <code>${meta.id}</code>
                </div>
                <div class="settings-task-detail-actions">
                    <button onClick=${() => window.open(sessionRecordingPlaybackUrl(meta.id), '_blank', 'noopener,noreferrer')}>${tr('settings.recordings.playback')}</button>
                    <button onClick=${onRefresh}>${tr('settings.recordings.refresh')}</button>
                    <button class="danger" onClick=${() => onDelete(meta)}>${tr('settings.recordings.delete')}</button>
                </div>
            </div>
            <div class="settings-task-detail-grid">
                <span>${tr('settings.recordings.status')}</span><strong>${meta.status || '—'}</strong>
                <span>${tr('settings.recordings.mode')}</span><strong>${modeLabel(meta.mode)}</strong>
                <span>${tr('settings.recordings.chat')}</span><code>${meta.chatJid || '—'}</code>
                <span>${tr('settings.recordings.started')}</span><strong>${formatDateTime(meta.startedAt)}</strong>
                <span>${tr('settings.recordings.ended')}</span><strong>${formatDateTime(meta.endedAt)}</strong>
                <span>${tr('settings.recordings.events')}</span><strong>${meta.eventCount ?? events.length}</strong>
                <span>${tr('settings.recordings.redactions')}</span><strong>${redactionCount}</strong>
            </div>
            <div class="settings-recording-export-row">
                <a href=${sessionRecordingExportUrl(meta.id, 'json')}>${tr('settings.recordings.exportJson')}</a>
                <a href=${sessionRecordingExportUrl(meta.id, 'jsonl')}>${tr('settings.recordings.exportJsonl')}</a>
                <a href=${sessionRecordingExportUrl(meta.id, 'html')}>${tr('settings.recordings.exportHtml')}</a>
            </div>
            <h4>${tr('settings.recordings.eventSummary')}</h4>
            ${events.length === 0 && html`<p class="settings-hint">${tr('settings.recordings.inspectHint')}</p>`}
            ${events.length > 0 && html`
                <div class="settings-recording-event-summary">
                    ${Object.entries(eventKinds).map(([kind, count]) => html`<${RecordingPill}>${kind}: ${count}<//>`)}
                </div>
                <div class="settings-task-command-block">
                    <strong>${tr('settings.recordings.firstEvents')}</strong>
                    <pre>${JSON.stringify(events.slice(0, 5), null, 2)}</pre>
                </div>
            `}
        </div>
    `;
}

export function RecordingsSection({ filter = '', setStatus }) {
    const { t: tr } = useTranslation();
    const [recordings, setRecordings] = useState([]);
    const [active, setActive] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [details, setDetails] = useState(null);
    const [acting, setActing] = useState(false);
    const [chatJid, setChatJid] = useState(readCurrentChatJid);
    const [title, setTitle] = useState('');
    const [mode, setMode] = useState('redacted');
    const [includeSnapshot, setIncludeSnapshot] = useState(true);
    const [customKeys, setCustomKeys] = useState('');
    const [customPatterns, setCustomPatterns] = useState('');
    const [previewInput, setPreviewInput] = useState('{"Authorization":"Bearer abc1234567890","content":"hello"}');
    const [previewResult, setPreviewResult] = useState(null);

    useEffect(() => {
        const onChatChange = (event) => {
            const next = String(event?.detail?.chatJid || '').trim();
            if (next) setChatJid(next);
        };
        window.addEventListener('piclaw:current-chat-changed', onChatChange);
        return () => window.removeEventListener('piclaw:current-chat-changed', onChatChange);
    }, []);

    const load = useCallback(async (preferredId = selectedId) => {
        setLoading(true);
        setError(null);
        try {
            const payload = await getSessionRecordings();
            const nextRecordings = payload.recordings || [];
            setRecordings(nextRecordings);
            setActive(payload.active || []);
            const nextSelected = nextRecordings.find(item => item.id === preferredId) || nextRecordings[0] || null;
            setSelectedId(nextSelected?.id || null);
            if (nextSelected?.id) setDetails(await getSessionRecording(nextSelected.id));
            else setDetails(null);
        } catch (e) {
            setError(e?.message || tr('settings.recordings.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [selectedId]);

    useEffect(() => { load(); }, [load]);

    const selected = useMemo(() => recordings.find(item => item.id === selectedId) || null, [recordings, selectedId]);
    const activeForChat = useMemo(() => active.find(item => item.chatJid === chatJid) || null, [active, chatJid]);
    const lf = String(filter || '').trim().toLowerCase();
    const filteredRecordings = useMemo(() => {
        if (!lf) return recordings;
        return recordings.filter(item => [item.id, item.title, item.chatJid, item.status, item.mode].some(value => String(value || '').toLowerCase().includes(lf)));
    }, [recordings, lf]);

    const selectRecording = useCallback(async (item) => {
        setSelectedId(item?.id || null);
        setDetails(null);
        if (!item?.id) return;
        try { setDetails(await getSessionRecording(item.id)); }
        catch (e) { setStatus?.(e?.message || tr('settings.recordings.loadOneFailed'), 'error'); }
    }, [setStatus]);

    const start = useCallback(async () => {
        if (acting) return;
        setActing(true);
        try {
            const redaction = {
                keys: parseList(customKeys),
                patterns: parseList(customPatterns),
            };
            const payload = await startSessionRecording({
                chat_jid: chatJid,
                title: title || undefined,
                mode,
                include_timeline_snapshot: includeSnapshot,
                timeline_snapshot_limit: 80,
                redaction,
            });
            setStatus?.(tr('settings.recordings.startedToast', { chat: chatJid }), 'success');
            await load(payload?.recording?.id);
        } catch (e) {
            setStatus?.(e?.message || tr('settings.recordings.startFailed'), 'error');
        } finally {
            setActing(false);
        }
    }, [acting, chatJid, customKeys, customPatterns, includeSnapshot, load, mode, setStatus, title]);

    const stop = useCallback(async (target = activeForChat) => {
        if (!target || acting) return;
        setActing(true);
        try {
            const payload = await stopSessionRecording({ id: target.id });
            setStatus?.(tr('settings.recordings.stoppedToast', { chat: target.chatJid }), 'success');
            await load(payload?.recording?.id);
        } catch (e) {
            setStatus?.(e?.message || tr('settings.recordings.stopFailed'), 'error');
        } finally {
            setActing(false);
        }
    }, [acting, activeForChat, load, setStatus]);

    const remove = useCallback(async (item) => {
        if (!item || acting) return;
        if (!window.confirm(tr('settings.recordings.deleteConfirm', { id: item.id }) + `\n\n${item.title || ''}`)) return;
        setActing(true);
        try {
            await deleteSessionRecording(item.id);
            setStatus?.(tr('settings.recordings.deletedToast'), 'success');
            await load(null);
        } catch (e) {
            setStatus?.(e?.message || tr('settings.recordings.deleteFailed'), 'error');
        } finally {
            setActing(false);
        }
    }, [acting, load, setStatus]);

    const runPreview = useCallback(async () => {
        try {
            const parsed = JSON.parse(previewInput || 'null');
            const payload = await previewSessionRecordingRedaction(parsed, { mode, redaction: { keys: parseList(customKeys), patterns: parseList(customPatterns) } });
            setPreviewResult(payload.preview);
        } catch (e) {
            setPreviewResult({ error: e?.message || tr('settings.recordings.previewFailed') });
        }
    }, [customKeys, customPatterns, mode, previewInput]);

    return html`
        <div class="settings-section settings-recordings-section">
            <div class="settings-recording-start-card">
                <h3>${tr('settings.recordings.heading')}</h3>
                <p class="settings-hint">${tr('settings.recordings.intro')}</p>
                <div class="settings-recording-form-grid">
                    <label>${tr('settings.recordings.chatJid')}<input value=${chatJid} onInput=${e => setChatJid(e.target.value)} /></label>
                    <label>${tr('settings.recordings.title')}<input placeholder=${tr('settings.recordings.titlePlaceholder')} value=${title} onInput=${e => setTitle(e.target.value)} /></label>
                    <label>${tr('settings.recordings.modeLabelField')}<select value=${mode} onChange=${e => setMode(e.target.value)}><option value="redacted">${tr('settings.recordings.optRedacted')}</option><option value="metadata">${tr('settings.recordings.optMetadata')}</option><option value="full">${tr('settings.recordings.optFull')}</option></select></label>
                    <label class="settings-recording-checkbox"><input type="checkbox" checked=${includeSnapshot} onChange=${e => setIncludeSnapshot(e.target.checked)} /> ${tr('settings.recordings.includeSnapshot')}</label>
                </div>
                <div class="settings-recording-form-grid settings-recording-redaction-grid">
                    <label>${tr('settings.recordings.extraKeys')}<textarea rows="2" placeholder="customer_id\ninternal_code" value=${customKeys} onInput=${e => setCustomKeys(e.target.value)} /></label>
                    <label>${tr('settings.recordings.extraPatterns')}<textarea rows="2" placeholder="ACME-[0-9]+" value=${customPatterns} onInput=${e => setCustomPatterns(e.target.value)} /></label>
                </div>
                <div class="settings-task-detail-actions">
                    ${activeForChat
                        ? html`<button onClick=${() => stop(activeForChat)} disabled=${acting}>${tr('settings.recordings.stopCurrent')}</button>`
                        : html`<button onClick=${start} disabled=${acting}>${tr('settings.recordings.start')}</button>`}
                    <button onClick=${() => load()} disabled=${loading}>${tr('settings.recordings.refresh')}</button>
                </div>
                ${active.length > 0 && html`<div class="settings-recording-active-row">${active.map(item => html`<${RecordingPill} type="active">REC ${item.chatJid}<//>`)}</div>`}
            </div>

            <details class="settings-recording-preview">
                <summary>${tr('settings.recordings.redactionPreview')}</summary>
                <textarea rows="4" value=${previewInput} onInput=${e => setPreviewInput(e.target.value)} />
                <div class="settings-task-detail-actions"><button onClick=${runPreview}>${tr('settings.recordings.previewRedaction')}</button></div>
                ${previewResult && html`<pre>${JSON.stringify(previewResult, null, 2)}</pre>`}
            </details>

            ${loading && html`<div class="settings-loading settings-loading-pane"><span class="settings-spinner"></span><span>${tr('settings.recordings.loading')}</span></div>`}
            ${error && html`<div class="settings-error-state">${error}</div>`}
            ${!loading && !error && recordings.length === 0 && html`<div class="settings-empty-state"><strong>${tr('settings.recordings.noneYet')}</strong><p>${tr('settings.recordings.noneYetHint')}</p></div>`}
            ${!loading && !error && recordings.length > 0 && html`
                <div class="settings-task-layout">
                    <div class="settings-task-list" role="listbox" aria-label=${tr('settings.recordings.listLabel')}>
                        ${filteredRecordings.map(item => html`
                            <button class=${`settings-task-row ${item.id === selectedId ? 'active' : ''}`} onClick=${() => selectRecording(item)}>
                                <span class="settings-task-row-main"><strong>${item.title || item.id}</strong><span>${item.chatJid} · ${formatDateTime(item.startedAt)}</span></span>
                                <span class="settings-task-row-meta"><${RecordingPill} type=${item.status === 'recording' ? 'active' : 'completed'}>${item.status}<//><${RecordingPill}>${modeLabel(item.mode)}<//></span>
                                <span class="settings-task-row-times">${tr('settings.recordings.eventsCount', { count: item.eventCount || 0 })}</span>
                            </button>
                        `)}
                        ${filteredRecordings.length === 0 && html`<p class="settings-hint">${tr('settings.recordings.noMatch', { filter })}</p>`}
                    </div>
                    <${RecordingDetail} recording=${selected} details=${details} onDelete=${remove} onRefresh=${() => selected && selectRecording(selected)} />
                </div>
            `}
        </div>
    `;
}

export const __recordingsSettingsTest = { formatDateTime, modeLabel, parseList };
