/**
 * markdown-preview.ts — Live markdown preview panel for the editor.
 *
 * Renders below the CodeMirror editor when activated via tab context menu.
 * Uses the same renderMarkdown() pipeline as the timeline so output is
 * visually consistent. Updates from editor content-change events with a
 * debounce to avoid re-rendering Markdown on every keystroke.
 *
 * Includes a draggable splitter at the top for resizing.
 */

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { useTranslation } from '../utils/i18n.js';
import { renderMarkdown, renderMermaidDiagrams } from '../markdown.js';
import { readStoredPanelHeight, writeStoredPanelHeight } from './markdown-preview-storage.js';

const RENDER_DEBOUNCE_MS = 120;
const SUBSCRIBE_RETRY_MS = 100;
const MAX_RENDER_CHARS = 96 * 1024;
const MIN_H = 60;
const DEFAULT_H = 220;
const LS_KEY = 'mdPreviewHeight';

function getStoredHeight() {
    return readStoredPanelHeight(localStorage, LS_KEY, MIN_H, DEFAULT_H);
}

/**
 * MarkdownPreview component.
 *
 * @param {Object} props
 * @param {() => string|undefined} props.getContent - Returns current editor content.
 * @param {(cb: (content: string) => void) => (() => void)|void} props.subscribeContentChange - Subscribe to editor content changes.
 * @param {string} props.path - File path (for display).
 * @param {() => void} props.onClose - Close the preview.
 */
export function MarkdownPreview({ getContent, subscribeContentChange, path, onClose }) {
    const { t } = useTranslation();
    const [renderedHtml, setRenderedHtml] = useState('');
    const [height, setHeight] = useState(getStoredHeight);
    const previewRef = useRef(null);
    const panelRef = useRef(null);
    const prevTextRef = useRef(null);
    const renderTimerRef = useRef(null);
    const subscribeRetryTimerRef = useRef(null);
    const getContentRef = useRef(getContent);
    const subscribeContentChangeRef = useRef(subscribeContentChange);

    // Keep refs in sync without restarting effects on parent re-renders.
    getContentRef.current = getContent;
    subscribeContentChangeRef.current = subscribeContentChange;

    // Render on editor content-change events instead of polling getContent().
    useEffect(() => {
        let disposed = false;

        const clearPendingRender = () => {
            if (renderTimerRef.current !== null) {
                clearTimeout(renderTimerRef.current);
                renderTimerRef.current = null;
            }
        };

        const clearSubscribeRetry = () => {
            if (subscribeRetryTimerRef.current !== null) {
                clearTimeout(subscribeRetryTimerRef.current);
                subscribeRetryTimerRef.current = null;
            }
        };

        const renderText = (text) => {
            if (disposed) return;
            if (text === prevTextRef.current) return;
            prevTextRef.current = text;
            if (String(text || '').length > MAX_RENDER_CHARS) {
                setRenderedHtml('<p style="color:var(--text-secondary)">Preview disabled for large documents to keep the editor responsive.</p>');
                return;
            }
            try {
                const h = renderMarkdown(text, null);
                setRenderedHtml(h);
            } catch {
                setRenderedHtml(`<p style="color:var(--text-secondary)">${t('mdpreview.unavailable')}</p>`);
            }
        };

        const scheduleRender = (text) => {
            clearPendingRender();
            renderTimerRef.current = setTimeout(() => {
                renderTimerRef.current = null;
                renderText(text || '');
            }, RENDER_DEBOUNCE_MS);
        };

        let unsubscribe = null;
        const subscribe = () => {
            if (disposed || unsubscribe) return;
            const maybeUnsubscribe = typeof subscribeContentChangeRef.current === 'function'
                ? subscribeContentChangeRef.current((content) => scheduleRender(content || ''))
                : null;
            if (typeof maybeUnsubscribe === 'function') {
                unsubscribe = maybeUnsubscribe;
                return;
            }
            // The preview can mount before the lazy editor instance is bound.
            // Retry subscription only; do not poll/serialize editor content.
            subscribeRetryTimerRef.current = setTimeout(subscribe, SUBSCRIBE_RETRY_MS);
        };

        renderText(getContentRef.current?.() || '');
        subscribe();

        return () => {
            disposed = true;
            clearPendingRender();
            clearSubscribeRetry();
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [path]);

    // Render mermaid diagrams after HTML update
    useEffect(() => {
        if (previewRef.current && renderedHtml) {
            renderMermaidDiagrams(previewRef.current).catch((error) => {
                console.debug('[markdown-preview] Mermaid rendering failed for the live preview.', error, { path });
            });
        }
    }, [renderedHtml]);

    // ── Splitter drag (mouse) ──
    const handleMouseDown = (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = panelRef.current?.offsetHeight || height;
        const container = panelRef.current?.parentElement;
        const maxH = container ? container.offsetHeight * 0.7 : 500;
        const splitter = e.currentTarget;
        splitter.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        const onMove = (me) => {
            // Dragging up ⇒ larger preview
            const h = Math.min(Math.max(startH - (me.clientY - startY), MIN_H), maxH);
            setHeight(h);
        };
        const onUp = () => {
            splitter.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            writeStoredPanelHeight(localStorage, LS_KEY, panelRef.current?.offsetHeight || height);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    // ── Splitter drag (touch) ──
    const handleTouchStart = (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        if (!touch) return;
        const startY = touch.clientY;
        const startH = panelRef.current?.offsetHeight || height;
        const container = panelRef.current?.parentElement;
        const maxH = container ? container.offsetHeight * 0.7 : 500;
        const splitter = e.currentTarget;
        splitter.classList.add('dragging');
        document.body.style.userSelect = 'none';

        const onMove = (te) => {
            const t = te.touches[0];
            if (!t) return;
            te.preventDefault();
            const h = Math.min(Math.max(startH - (t.clientY - startY), MIN_H), maxH);
            setHeight(h);
        };
        const onUp = () => {
            splitter.classList.remove('dragging');
            document.body.style.userSelect = '';
            writeStoredPanelHeight(localStorage, LS_KEY, panelRef.current?.offsetHeight || height);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            document.removeEventListener('touchcancel', onUp);
        };
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
        document.addEventListener('touchcancel', onUp);
    };

    return html`
        <div
            class="md-preview-splitter"
            onMouseDown=${handleMouseDown}
            onTouchStart=${handleTouchStart}
        ></div>
        <div class="md-preview-panel" ref=${panelRef} style=${{ height: height + 'px' }}>
            <div class="md-preview-header">
                <span class="md-preview-title">Preview</span>
                <button class="md-preview-close" onClick=${onClose} title=${t('mdpreview.close')} aria-label=${t('mdpreview.close')}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                        <line x1="4" y1="4" x2="12" y2="12"/>
                        <line x1="12" y1="4" x2="4" y2="12"/>
                    </svg>
                </button>
            </div>
            <div
                class="md-preview-body post-content"
                ref=${previewRef}
                dangerouslySetInnerHTML=${{ __html: renderedHtml }}
            />
        </div>
    `;
}
