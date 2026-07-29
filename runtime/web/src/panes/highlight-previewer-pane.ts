/**
 * highlight-previewer-pane.ts — Syntax-highlighted source/text preview pane.
 *
 * Claims any text file that isn't markdown (priority ~10) and renders it
 * with line numbers and full syntax highlighting via code-highlighting.ts.
 * Replaces the unstyled plain-text branch of workspace-preview-pane.ts.
 */

import type { PaneCapability, PaneContext, PaneInstance, WebPaneExtension } from './pane-types.js';
import { getWorkspaceRawUrl } from '../api.js';
import { highlightCodeLinesAsHtml, parserForCodeFenceLanguage, normalizeCodeLanguageLabel, extensionToLanguage } from '../utils/code-highlighting.js';

const MARKDOWN_EXTENSIONS = /\.(md|mdx|markdown)$/i;
const LARGE_PREVIEW_CHARS = 96 * 1024;
const LARGE_PREVIEW_LINES = 2_500;

function countLinesUpTo(text: string, limit: number): number {
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            lines += 1;
            if (lines > limit) return lines;
        }
    }
    return lines;
}

/** Map file extension to language identifier for highlighting. */

class HighlightPreviewInstance implements PaneInstance {
    private container: HTMLElement;
    private content: string = '';
    private lang: string = '';
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context?.path || '';
        this.lang = extensionToLanguage(filePath);

        // Prefer inline preview payload; /workspace/file returns `text`, not `content`.
        const preview = (context as any)?.preview;
        const inline =
            (typeof preview?.text === 'string' ? preview.text : undefined)
            ?? (typeof preview?.content === 'string' ? preview.content : undefined)
            ?? (typeof (context as any)?.content === 'string' ? (context as any).content : undefined);
        if (inline !== undefined) {
            this.content = inline;
            this.render();
        } else {
            this.loadContent(filePath);
        }
    }

    private async loadContent(filePath: string) {
        if (this.disposed) return;
        try {
            const res = await fetch(getWorkspaceRawUrl(filePath));
            if (!res.ok) {
                this.container.textContent = `Failed to load: ${res.status}`;
                return;
            }
            this.content = await res.text();
            if (!this.disposed) this.render();
        } catch (err) {
            if (!this.disposed) this.container.textContent = `Error loading file.`;
        }
    }

    private render() {
        const langLabel = this.lang ? normalizeCodeLanguageLabel(this.lang) : 'Plain text';
        const lineCount = countLinesUpTo(this.content, LARGE_PREVIEW_LINES);
        const largePreview = this.content.length > LARGE_PREVIEW_CHARS || lineCount > LARGE_PREVIEW_LINES;

        if (largePreview) {
            this.container.innerHTML = `
                <div class="highlight-preview" style="height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--bg-primary,#1e1e1e);">
                    <div class="hl-toolbar" style="flex:0 0 auto;padding:4px 12px;background:var(--bg-secondary,#252526);border-bottom:1px solid var(--border-color,#333);font-size:11px;color:var(--text-secondary,#888);display:flex;justify-content:space-between;">
                        <span>${this.escapeHtml(langLabel)} · large file mode</span>
                        <span>${lineCount > LARGE_PREVIEW_LINES ? `${LARGE_PREVIEW_LINES}+` : lineCount} lines</span>
                    </div>
                    <div class="hl-code-container" style="flex:1;overflow:auto;font-family:var(--code-font,'JetBrains Mono',monospace);font-size:13px;line-height:1.5;">
                        <pre class="hl-code" style="padding:8px 12px;margin:0;white-space:pre;overflow-x:auto;">${this.escapeHtml(this.content)}</pre>
                    </div>
                </div>
            `;
            return;
        }

        const hasParser = this.lang ? !!parserForCodeFenceLanguage(this.lang) : false;
        const lines = hasParser
            ? highlightCodeLinesAsHtml(this.content, this.lang)
            : this.content.split('\n').map(line => this.escapeHtml(line) || '&nbsp;');

        const lineNumbers = lines.map((_, i) => `<span class="hl-line-number">${i + 1}</span>`).join('\n');
        const codeLines = lines.join('\n');

        this.container.innerHTML = `
            <div class="highlight-preview" style="height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--bg-primary,#1e1e1e);">
                <div class="hl-toolbar" style="flex:0 0 auto;padding:4px 12px;background:var(--bg-secondary,#252526);border-bottom:1px solid var(--border-color,#333);font-size:11px;color:var(--text-secondary,#888);display:flex;justify-content:space-between;">
                    <span>${this.escapeHtml(langLabel)}</span>
                    <span>${lines.length} lines</span>
                </div>
                <div class="hl-code-container" style="flex:1;overflow:auto;font-family:var(--code-font,'JetBrains Mono',monospace);font-size:13px;line-height:1.5;">
                    <div style="display:flex;min-height:100%;">
                        <pre class="hl-line-numbers" style="flex:0 0 auto;padding:8px 8px 8px 12px;text-align:right;color:var(--text-tertiary,#555);user-select:none;border-right:1px solid var(--border-color,#333);">${lineNumbers}</pre>
                        <pre class="hl-code" style="flex:1;padding:8px 12px;margin:0;white-space:pre;overflow-x:auto;">${codeLines}</pre>
                    </div>
                </div>
            </div>
        `;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    dispose() { this.disposed = true; this.container.innerHTML = ''; }
    resize() {}
    focus() {}
    setContent(content: string) { this.content = content; this.render(); }
    getContent() { return this.content; }
    isDirty() { return false; }
}

export const highlightPreviewerPaneExtension: WebPaneExtension = {
    id: 'highlight-previewer',
    label: 'Source Preview',
    icon: 'code',
    capabilities: ['preview'] as PaneCapability[],
    placement: 'tabs',

    canHandle(context: PaneContext): boolean | number {
        if (context?.mode !== 'view') return false;
        const path = context?.path || '';
        // Don't claim markdown (handled by markdown-preview pane)
        if (MARKDOWN_EXTENSIONS.test(path)) return false;
        // Claim any file that has a known language mapping
        const lang = extensionToLanguage(path);
        if (lang) return 10;
        // Also claim generic text files from preview API
        const preview = (context as any)?.preview;
        if (preview?.kind === 'text' && preview?.content_type !== 'text/markdown') return 5;
        return false;
    },

    mount(container: HTMLElement, context: PaneContext): PaneInstance {
        return new HighlightPreviewInstance(container, context);
    },
};
