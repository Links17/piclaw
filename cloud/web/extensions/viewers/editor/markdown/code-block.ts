/**
 * code-block.ts — Fenced code block decorations.
 *
 * Uses Decoration.line() for continuous background styling across
 * multiple content lines (instead of Decoration.mark() which wraps
 * each line individually).
 *
 * Lezer structure:
 *   FencedCode → CodeMark(```) + CodeInfo? + CodeText? + CodeMark(```)
 *
 * Rendering (cursor not inside):
 *   - Opening ``` line → language badge + copy button header
 *   - Content lines   → syntax-highlighted monospace lines
 *   - Closing ``` line → collapsed to padding spacer
 */
import { registerDecorator, Decoration, WidgetType } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';
import {
    highlightCodeLinesAsHtml,
    normalizeCodeLanguageLabel,
} from '../../../../web/src/utils/code-highlighting.js';

const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';


type HighlightedCodeBlock = {
    codeText: string;
    highlightedLines: string[];
};

const highlightedCodeBlockCache = new WeakMap<object, Map<string, HighlightedCodeBlock>>();

async function writeToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for environments without clipboard permissions
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', 'true');
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }
}

class CodeBlockHeaderWidget extends WidgetType {
    langLabel: string;
    code: string;

    constructor(lang: string, code: string) {
        super();
        this.langLabel = normalizeCodeLanguageLabel(lang);
        this.code = code;
    }

    toDOM(): HTMLElement {
        const root = document.createElement('span');
        root.className = 'cm-md-code-block-header';

        const lang = document.createElement('span');
        lang.className = 'cm-md-code-block-lang';
        lang.textContent = this.langLabel;
        root.appendChild(lang);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-md-code-copy-btn';
        btn.setAttribute('aria-label', 'Copy code block');
        btn.innerHTML = `<span class="cm-md-code-copy-icon" aria-hidden="true">${COPY_ICON_SVG}</span><span class="cm-md-code-copy-label">Copy</span>`;

        let resetTimer: number | null = null;
        const setState = (state: 'idle' | 'copied' | 'error') => {
            btn.dataset.state = state;
            const icon = btn.querySelector('.cm-md-code-copy-icon');
            const label = btn.querySelector('.cm-md-code-copy-label');
            if (!icon || !label) return;

            if (state === 'copied') {
                icon.innerHTML = CHECK_ICON_SVG;
                label.textContent = 'Copied';
            } else if (state === 'error') {
                icon.innerHTML = COPY_ICON_SVG;
                label.textContent = 'Failed';
            } else {
                icon.innerHTML = COPY_ICON_SVG;
                label.textContent = 'Copy';
            }
        };

        const copyAction = async (event: Event) => {
            event.preventDefault();
            event.stopPropagation();

            const ok = await writeToClipboard(this.code);
            setState(ok ? 'copied' : 'error');

            if (resetTimer !== null) window.clearTimeout(resetTimer);
            resetTimer = window.setTimeout(() => setState('idle'), 1300);
        };

        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        btn.addEventListener('click', (e) => {
            void copyAction(e);
        });

        root.appendChild(btn);
        return root;
    }

    eq(other: CodeBlockHeaderWidget): boolean {
        return this.langLabel === other.langLabel && this.code === other.code;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

class CodeLineWidget extends WidgetType {
    html: string;

    constructor(html: string) {
        super();
        this.html = html;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-code-content';
        span.innerHTML = this.html;
        return span;
    }

    eq(other: CodeLineWidget): boolean {
        return this.html === other.html;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

class CodeBlockSpacerWidget extends WidgetType {
    toDOM(): HTMLElement {
        const div = document.createElement('div');
        div.className = 'cm-md-code-block-spacer';
        div.innerHTML = '&nbsp;';
        return div;
    }

    eq(): boolean {
        return true;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

function getHighlightedCodeBlock(doc: any, openLineNo: number, closeLineNo: number, lang: string): HighlightedCodeBlock {
    const cacheKey = `${openLineNo}:${closeLineNo}:${lang}`;
    const docKey = doc as object;
    let docCache = highlightedCodeBlockCache.get(docKey);
    if (!docCache) {
        docCache = new Map<string, HighlightedCodeBlock>();
        highlightedCodeBlockCache.set(docKey, docCache);
    }

    const cached = docCache.get(cacheKey);
    if (cached) return cached;

    let codeText = '';
    if (closeLineNo > openLineNo + 1) {
        const codeFrom = doc.line(openLineNo + 1).from;
        const codeTo = doc.line(closeLineNo - 1).to;
        codeText = doc.sliceString(codeFrom, codeTo);
    }

    const computed = {
        codeText,
        highlightedLines: highlightCodeLinesAsHtml(codeText, lang),
    } satisfies HighlightedCodeBlock;
    docCache.set(cacheKey, computed);
    return computed;
}

function fencedCodeDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];
    const doc = view.state.doc;

    let lang = '';
    const marks: SyntaxNode[] = [];

    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'CodeMark') marks.push(child);
        else if (child.type.name === 'CodeInfo') {
            lang = doc.sliceString(child.from, child.to).trim();
        }
    }

    if (marks.length < 2) return entries;

    const openFence = marks[0];
    const closeFence = marks[marks.length - 1];
    const openLine = doc.lineAt(openFence.from);
    const closeLine = doc.lineAt(closeFence.from);

    const { codeText, highlightedLines } = getHighlightedCodeBlock(doc, openLine.number, closeLine.number, lang);

    // Opening fence: replace text content with language badge + copy action
    entries.push({
        from: openLine.from,
        to: openLine.to,
        decoration: Decoration.replace({ widget: new CodeBlockHeaderWidget(lang, codeText) }),
    });
    // Style the line as the code block header
    entries.push({
        from: openLine.from,
        to: openLine.from,
        decoration: Decoration.line({ class: 'cm-md-code-fence-open' }),
    });

    // Content lines: line styling + syntax-highlighted widget content.
    for (let lineNo = openLine.number + 1; lineNo < closeLine.number; lineNo++) {
        const line = doc.line(lineNo);
        const isLast = lineNo === closeLine.number - 1;
        const rel = lineNo - (openLine.number + 1);
        const html = highlightedLines[rel] ?? (escapeHtml(line.text) || '&nbsp;');

        entries.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({
                class: isLast
                    ? 'cm-md-code-line cm-md-code-line-last'
                    : 'cm-md-code-line',
            }),
        });
        entries.push({
            from: line.from,
            to: line.to,
            decoration: line.from === line.to
                ? Decoration.widget({ widget: new CodeLineWidget(html), side: 1 })
                : Decoration.replace({ widget: new CodeLineWidget(html) }),
        });
    }

    // Closing fence: replace text with a block spacer widget so the block ends
    // with consistent bottom padding, independent of browser baseline quirks.
    entries.push({
        from: closeLine.from,
        to: closeLine.to,
        decoration: Decoration.replace({
            widget: new CodeBlockSpacerWidget(),
        }),
    });
    entries.push({
        from: closeLine.from,
        to: closeLine.from,
        decoration: Decoration.line({ class: 'cm-md-code-fence-close' }),
    });

    return entries;
}

registerDecorator('FencedCode', fencedCodeDecorator);
