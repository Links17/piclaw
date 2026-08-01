/**
 * footnote.ts — Footnote reference + definition decorators.
 *
 * Decorates `[^ref]` patterns as superscript footnote references.
 *
 * Fit-gap parity upgrades:
 * - Clickable reference jumps to definition when present.
 * - Unresolved references get a distinct style.
 * - Footnote definition rows get a compact label/content presentation.
 * - Definition label offers a back-reference jump to first reference.
 */
import { registerDecorator, Decoration, WidgetType } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

// ── Lezer parser extension ──────────────────────────────────────

export const FOOTNOTE_REF_NODE = 'FootnoteRef';

export const footnoteExtension = {
    defineNodes: [FOOTNOTE_REF_NODE],
    parseInline: [{
        name: FOOTNOTE_REF_NODE,
        parse(cx: any, next: number, pos: number): number {
            // Match `[^` at current position
            if (next !== 91 /* [ */) return -1;
            const after = cx.slice(pos, pos + 2);
            if (after !== '[^') return -1;

            // Find closing `]`
            let end = pos + 2;
            const max = Math.min(pos + 50, cx.end); // footnote refs are short
            while (end < max) {
                const ch = cx.char(end);
                if (ch === 93 /* ] */) {
                    // Found closing bracket
                    const ref = cx.slice(pos + 2, end);
                    // Validate: must be non-empty, no spaces, alphanumeric/dash/underscore
                    if (ref.length > 0 && /^[\w-]+$/.test(ref)) {
                        cx.addElement(cx.elt(FOOTNOTE_REF_NODE, pos, end + 1));
                        return end + 1;
                    }
                    return -1;
                }
                if (ch === 10 /* \n */ || ch === 32 /* space */) return -1;
                end++;
            }
            return -1;
        },
    }],
};

type FootnoteDocIndex = {
    definitionByRef: Map<string, number>;
    refPositionsByRef: Map<string, number[]>;
};

const footnoteDocIndexCache = new WeakMap<object, FootnoteDocIndex>();

function buildFootnoteDocIndex(doc: any): FootnoteDocIndex {
    const text = doc.sliceString(0, doc.length);
    const definitionByRef = new Map<string, number>();
    const refPositionsByRef = new Map<string, number[]>();

    const definitionRe = /^\[\^([\w-]+)\]:/gm;
    let match: RegExpExecArray | null;
    while ((match = definitionRe.exec(text)) !== null) {
        const ref = match[1];
        if (!definitionByRef.has(ref)) {
            definitionByRef.set(ref, match.index);
        }
    }

    const refRe = /\[\^([\w-]+)\](?!:)/g;
    while ((match = refRe.exec(text)) !== null) {
        const ref = match[1];
        const positions = refPositionsByRef.get(ref) || [];
        positions.push(match.index);
        refPositionsByRef.set(ref, positions);
    }

    return { definitionByRef, refPositionsByRef };
}

function getFootnoteDocIndex(view: EditorView): FootnoteDocIndex {
    const doc = view.state.doc as object;
    const cached = footnoteDocIndexCache.get(doc);
    if (cached) return cached;
    const built = buildFootnoteDocIndex(view.state.doc);
    footnoteDocIndexCache.set(doc, built);
    return built;
}

function findFootnoteDefinitionPos(view: EditorView, ref: string): number | null {
    return getFootnoteDocIndex(view).definitionByRef.get(ref) ?? null;
}

function findFirstFootnoteRefPos(view: EditorView, ref: string, beforePos = view.state.doc.length): number | null {
    const positions = getFootnoteDocIndex(view).refPositionsByRef.get(ref);
    if (!positions || positions.length === 0) return null;
    for (const pos of positions) {
        if (pos >= beforePos) break;
        return pos;
    }
    return null;
}

function parseFootnoteDefinitionLine(text: string): { ref: string; labelEndOffset: number; contentOffset: number } | null {
    const match = text.match(/^\[\^([\w-]+)\]:/);
    if (!match) return null;

    const labelEndOffset = match[0].length;
    let contentOffset = labelEndOffset;
    if (text.charAt(contentOffset) === ' ') contentOffset++;

    return {
        ref: match[1],
        labelEndOffset,
        contentOffset,
    };
}

// ── Widgets ─────────────────────────────────────────────────────

class FootnoteRefWidget extends WidgetType {
    ref: string;
    targetPos: number | null;

    constructor(ref: string, targetPos: number | null) {
        super();
        this.ref = ref;
        this.targetPos = targetPos;
    }

    toDOM(view: EditorView): HTMLElement {
        const sup = document.createElement('sup');
        const link = document.createElement('a');
        link.className = this.targetPos === null
            ? 'cm-md-footnote-ref cm-md-footnote-ref-unresolved'
            : 'cm-md-footnote-ref';
        link.textContent = this.ref;
        link.href = '#';
        link.title = this.targetPos === null
            ? `Missing footnote definition: ${this.ref}`
            : `Jump to footnote: ${this.ref}`;

        link.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.targetPos === null) return;
            view.dispatch({
                selection: { anchor: this.targetPos },
                scrollIntoView: true,
            });
            view.focus();
        });

        sup.appendChild(link);
        return sup;
    }

    eq(other: FootnoteRefWidget): boolean {
        return this.ref === other.ref && this.targetPos === other.targetPos;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

class FootnoteDefLabelWidget extends WidgetType {
    ref: string;
    backRefPos: number | null;

    constructor(ref: string, backRefPos: number | null) {
        super();
        this.ref = ref;
        this.backRefPos = backRefPos;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('span');
        wrap.className = 'cm-md-footnote-def-label';

        const badge = document.createElement('span');
        badge.className = 'cm-md-footnote-def-badge';
        badge.textContent = this.ref;
        wrap.appendChild(badge);

        const back = document.createElement('a');
        back.className = this.backRefPos === null
            ? 'cm-md-footnote-def-back cm-md-footnote-def-back-disabled'
            : 'cm-md-footnote-def-back';
        back.href = '#';
        back.textContent = '↩';
        back.title = this.backRefPos === null
            ? 'No back-reference found'
            : 'Jump back to first reference';

        back.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        back.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.backRefPos === null) return;
            view.dispatch({
                selection: { anchor: this.backRefPos },
                scrollIntoView: true,
            });
            view.focus();
        });

        wrap.appendChild(back);
        return wrap;
    }

    eq(other: FootnoteDefLabelWidget): boolean {
        return this.ref === other.ref && this.backRefPos === other.backRefPos;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

// ── Decorators ──────────────────────────────────────────────────

function decorateInlineRefsInParagraph(entries: DecorationEntry[], node: SyntaxNode, view: EditorView): void {
    const doc = view.state.doc;

    const startLineNo = doc.lineAt(node.from).number;
    const endLineNo = doc.lineAt(Math.max(node.from, node.to - 1)).number;

    for (let ln = startLineNo; ln <= endLineNo; ln++) {
        const line = doc.line(ln);
        const text = line.text;

        const re = /\[\^([\w-]+)\]/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const index = match.index;
            const ref = match[1];
            const after = text.charAt(index + match[0].length);

            // Skip definition labels like `[^ref]:`.
            if (after === ':') continue;

            const from = line.from + index;
            const to = from + match[0].length;
            const targetPos = findFootnoteDefinitionPos(view, ref);

            entries.push({
                from,
                to,
                decoration: Decoration.replace({
                    widget: new FootnoteRefWidget(ref, targetPos),
                }),
            });
        }
    }
}

function footnoteDefinitionDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];
    const doc = view.state.doc;

    // Inline refs (works even if custom FootnoteRef parser node is unavailable).
    decorateInlineRefsInParagraph(entries, node, view);

    const startLineNo = doc.lineAt(node.from).number;
    const endLineNo = doc.lineAt(Math.max(node.from, node.to - 1)).number;

    // A single Paragraph node can contain multiple footnote definition lines
    // (e.g. [^1]: ... followed by [^note]: ...). Decorate each one.
    for (let ln = startLineNo; ln <= endLineNo; ln++) {
        const line = doc.line(ln);
        const parsed = parseFootnoteDefinitionLine(line.text);
        if (!parsed) continue;

        let lastLineNo = line.number;
        for (let nextNo = line.number + 1; nextNo <= doc.lines; nextNo++) {
            const next = doc.line(nextNo);
            // Next definition starts a new block.
            if (/^\[\^[\w-]+\]:/.test(next.text)) break;
            if (/^\s*$/.test(next.text)) {
                lastLineNo = nextNo;
                continue;
            }
            if (/^( {4}|\t)/.test(next.text)) {
                lastLineNo = nextNo;
                continue;
            }
            break;
        }

        // Row styling for first + continuation rows.
        entries.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({ class: 'cm-md-footnote-def-line cm-md-footnote-def-line-first' }),
        });
        for (let contNo = line.number + 1; contNo <= lastLineNo; contNo++) {
            const current = doc.line(contNo);
            entries.push({
                from: current.from,
                to: current.from,
                decoration: Decoration.line({
                    class: contNo === lastLineNo
                        ? 'cm-md-footnote-def-line cm-md-footnote-def-line-cont cm-md-footnote-def-line-last'
                        : 'cm-md-footnote-def-line cm-md-footnote-def-line-cont',
                }),
            });

            const indentMatch = current.text.match(/^( {4}|\t)+/);
            if (indentMatch) {
                entries.push({
                    from: current.from,
                    to: current.from + indentMatch[0].length,
                    decoration: Decoration.replace({}),
                });
            }
        }

        const labelEnd = line.from + parsed.labelEndOffset;
        const contentFrom = line.from + parsed.contentOffset;
        const backRefPos = findFirstFootnoteRefPos(view, parsed.ref, line.from);

        // Replace [^ref]: with label/backref widget.
        entries.push({
            from: line.from,
            to: labelEnd,
            decoration: Decoration.replace({
                widget: new FootnoteDefLabelWidget(parsed.ref, backRefPos),
            }),
        });

        if (contentFrom < line.to) {
            entries.push({
                from: contentFrom,
                to: line.to,
                decoration: Decoration.mark({ class: 'cm-md-footnote-def-text' }),
            });
        }

        ln = lastLineNo;
    }

    return entries;
}

registerDecorator('Paragraph', footnoteDefinitionDecorator);
