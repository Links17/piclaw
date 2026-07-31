/**
 * web-viewer-pane.ts — Unified browser-native viewer for HTML, images, video, and PDF.
 *
 * Consolidates html-viewer-pane, image-viewer-pane, video-viewer-pane, and
 * pdf-viewer-pane into a single WebPaneExtension. Each file type renders
 * with its natural browser element: iframe, <img>, <video>, or <embed>.
 */

import type { PaneCapability, PaneContext, PaneInstance, WebPaneExtension } from './pane-types.js';

const HTML_EXTENSIONS  = /\.(html|htm)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|ogv)$/i;
const PDF_EXTENSIONS   = /\.pdf$/i;

type WebViewerKind = 'html' | 'image' | 'video' | 'pdf' | null;

function detectKind(path: string): WebViewerKind {
    if (HTML_EXTENSIONS.test(path)) return 'html';
    if (IMAGE_EXTENSIONS.test(path)) return 'image';
    if (VIDEO_EXTENSIONS.test(path)) return 'video';
    if (PDF_EXTENSIONS.test(path)) return 'pdf';
    return null;
}


// ── html-viewer ──────────────────────────────────────────────────────────
/**
 * html-viewer-pane.ts — WebPaneExtension for HTML file preview.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab" button.
 * In edit/tab mode: loads the HTML viewer route in an iframe (rendered preview).
 */



function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Preview card (workspace browser) ────────────────────────────

class HtmlPreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'index.html';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;">
                <div style="text-align:center;">
                    <div style="font-size:48px;margin-bottom:12px;">🌐</div>
                    <div style="font-size:14px;color:var(--text-primary,#e2e8f0);font-weight:500;margin-bottom:4px;">${esc(name)}</div>
                    <div style="font-size:12px;color:var(--text-secondary,#94a3b8);">HTML document</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-top:1px solid var(--border-color,#333);flex-shrink:0;">
                <div style="font-size:12px;color:var(--text-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${esc(filePath)}</div>
                <div style="display:flex;gap:8px;flex-shrink:0;">
                    <button id="html-edit-btn" style="padding:5px 14px;background:var(--surface-color,rgba(148,163,184,.12));color:var(--text-primary,#e2e8f0);
                        border:none;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;
                        transition:background 0.15s;">
                        Edit Source
                    </button>
                    <button id="html-open-tab" style="padding:5px 14px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                        border:none;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;
                        transition:background 0.15s;"
                        onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                        onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                        Preview in Tab
                    </button>
                </div>
            </div>
        `;
        container.appendChild(wrapper);

        const previewBtn = wrapper.querySelector('#html-open-tab') as HTMLButtonElement;
        if (previewBtn) {
            previewBtn.addEventListener('click', () => {
                container.dispatchEvent(new CustomEvent('html-viewer:open-tab', {
                    bubbles: true,
                    detail: { path: filePath },
                }));
            });
        }

        const editBtn = wrapper.querySelector('#html-edit-btn') as HTMLButtonElement;
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                container.dispatchEvent(new CustomEvent('html-viewer:edit-source', {
                    bubbles: true,
                    detail: { path: filePath },
                }));
            });
        }
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void {}
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.container.innerHTML = '';
    }
}

// ── Full viewer (editor tab) ────────────────────────────────────

class HtmlViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const viewerUrl = `/html-viewer/?path=${encodeURIComponent(filePath)}`;

        this.iframe = document.createElement('iframe');
        this.iframe.src = viewerUrl;
        this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
        container.appendChild(this.iframe);
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void { this.iframe?.focus(); }
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.iframe) {
            this.iframe.src = 'about:blank';
            this.iframe = null;
        }
        this.container.innerHTML = '';
    }
}

// ── Extension ───────────────────────────────────────────────────


// ── image-viewer ──────────────────────────────────────────────────────────
/**
 * image-viewer-pane.ts — WebPaneExtension for image viewing.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab" button.
 * In edit/tab mode: loads the image viewer route in an iframe (zoom, checkerboard bg).
 */




// ── Preview card (workspace browser) ────────────────────────────

class ImagePreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'image';
        const rawUrl = `/workspace/raw?path=${encodeURIComponent(filePath)}`;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:16px;">
                <img src="${esc(rawUrl)}" alt="${esc(name)}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;" />
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-top:1px solid var(--border-color,#333);flex-shrink:0;">
                <div style="font-size:12px;color:var(--text-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${esc(name)}</div>
                <button id="img-open-tab" style="padding:5px 14px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                    border:none;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;flex-shrink:0;
                    transition:background 0.15s;"
                    onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                    onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                    Open in Tab
                </button>
            </div>
        `;
        container.appendChild(wrapper);

        const btn = wrapper.querySelector('#img-open-tab') as HTMLButtonElement;
        if (btn) {
            btn.addEventListener('click', () => {
                const evt = new CustomEvent('image-viewer:open-tab', {
                    bubbles: true,
                    detail: { path: filePath },
                });
                container.dispatchEvent(evt);
            });
        }
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void {}
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.container.innerHTML = '';
    }
}

// ── Full viewer (editor tab) ────────────────────────────────────

class ImageViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const viewerUrl = `/image-viewer/?path=${encodeURIComponent(filePath)}`;

        this.iframe = document.createElement('iframe');
        this.iframe.src = viewerUrl;
        this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:var(--bg-primary,#000);';
        container.appendChild(this.iframe);
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void { this.iframe?.focus(); }
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.iframe) {
            this.iframe.src = 'about:blank';
            this.iframe = null;
        }
        this.container.innerHTML = '';
    }
}

// ── Extension ───────────────────────────────────────────────────


// ── video-viewer ──────────────────────────────────────────────────────────
/**
 * video-viewer-pane.ts — WebPaneExtension for workspace video viewing.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab".
 * In edit/tab mode: loads the video viewer route in an iframe.
 */




class VideoPreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'video.mp4';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="text-align:center;max-width:360px;padding:24px;">
                <div style="font-size:56px;margin-bottom:12px;">🎬</div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${esc(name)}</div>
                <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">Video File</div>
                <button id="video-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                    border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;
                    transition:background 0.15s;"
                    onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                    onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                    Open in Tab
                </button>
            </div>
        `;
        container.appendChild(wrapper);

        const btn = wrapper.querySelector('#video-open-tab') as HTMLButtonElement;
        if (btn) {
            btn.addEventListener('click', () => {
                const evt = new CustomEvent('video-viewer:open-tab', {
                    bubbles: true,
                    detail: { path: filePath },
                });
                container.dispatchEvent(evt);
            });
        }
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void {}
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.container.innerHTML = '';
    }
}

class VideoViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const viewerUrl = `/video-viewer/?path=${encodeURIComponent(filePath)}`;

        this.iframe = document.createElement('iframe');
        this.iframe.src = viewerUrl;
        this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:#111;';
        container.appendChild(this.iframe);
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void { this.iframe?.focus(); }
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.iframe) {
            this.iframe.src = 'about:blank';
            this.iframe = null;
        }
        this.container.innerHTML = '';
    }
}


// ── pdf-viewer ──────────────────────────────────────────────────────────
/**
 * pdf-viewer-pane.ts — WebPaneExtension for PDF viewing.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab" button.
 * In edit/tab mode: loads a same-origin PDF wrapper page that embeds the raw PDF.
 * Zero chrome — no pdf.js; falls back to an open-in-new-tab link when embedding fails.
 */




// ── Preview card (workspace browser) ────────────────────────────

class PdfPreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'document.pdf';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="text-align:center;max-width:360px;padding:24px;">
                <div style="font-size:56px;margin-bottom:12px;">📄</div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${esc(name)}</div>
                <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">PDF Document</div>
                <button id="pdf-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                    border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;
                    transition:background 0.15s;"
                    onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                    onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                    Open in Tab
                </button>
            </div>
        `;
        container.appendChild(wrapper);

        const btn = wrapper.querySelector('#pdf-open-tab') as HTMLButtonElement;
        if (btn) {
            btn.addEventListener('click', () => {
                const evt = new CustomEvent('pdf-viewer:open-tab', {
                    bubbles: true,
                    detail: { path: filePath },
                });
                container.dispatchEvent(evt);
            });
        }
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void {}
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.container.innerHTML = '';
    }
}

// ── Full viewer (editor tab) ────────────────────────────────────

class PdfViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const viewerUrl = `/pdf-viewer/?path=${encodeURIComponent(filePath)}`;

        this.iframe = document.createElement('iframe');
        this.iframe.src = viewerUrl;
        this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:#1e1e1e;';
        container.appendChild(this.iframe);
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void { this.iframe?.focus(); }
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.iframe) {
            this.iframe.src = 'about:blank';
            this.iframe = null;
        }
        this.container.innerHTML = '';
    }
}

// ── Extension ───────────────────────────────────────────────────


// ── Unified web viewer extension ────────────────────────────────────────────

const PRIORITY: Record<WebViewerKind & string, number> = {
    html: 30,
    image: 48,
    pdf: 52,
    video: 54,
};

export const webViewerPaneExtension: WebPaneExtension = {
    id: 'web-viewer',
    label: 'Web Viewer',
    icon: 'eye',
    capabilities: ['preview'] as PaneCapability[],
    placement: 'tabs',

    canHandle(context: PaneContext): boolean | number {
        const path = context?.path || '';
        const kind = detectKind(path);
        if (!kind) return false;
        return PRIORITY[kind] ?? 30;
    },

    mount(container: HTMLElement, context: PaneContext): PaneInstance {
        const path = context?.path || '';
        const kind = detectKind(path);
        const isPreview = context?.mode === 'view';

        switch (kind) {
            case 'html':
                return isPreview ? new HtmlPreviewCard(container, context) : new HtmlViewerInstance(container, context);
            case 'image':
                return isPreview ? new ImagePreviewCard(container, context) : new ImageViewerInstance(container, context);
            case 'video':
                return isPreview ? new VideoPreviewCard(container, context) : new VideoViewerInstance(container, context);
            case 'pdf':
                return isPreview ? new PdfPreviewCard(container, context) : new PdfViewerInstance(container, context);
            default:
                // Should never reach here (canHandle returns false for unknown)
                container.textContent = 'Unsupported file type.';
                return { dispose() {}, resize() {}, focus() {}, setContent() {}, getContent() { return null; }, isDirty() { return false; } };
        }
    },
};
