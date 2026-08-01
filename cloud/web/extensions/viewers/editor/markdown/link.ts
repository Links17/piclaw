/**
 * link.ts — Link and image decorations.
 *
 * Links: replace markdown syntax with clickable link widget.
 * Images: show inline image widget with optional caption.
 * Reference links: resolve [text][label], [text][], and [text] from
 * LinkReference definitions and render them as normal safe link widgets.
 *
 * Lezer structure:
 *   Inline link       → LinkMark("[") + content + LinkMark("](") + URL + LinkMark(")")
 *   Reference link    → LinkMark("[") + content + LinkMark("]") + LinkLabel("[ref]")
 *   Shortcut ref link → LinkMark("[") + content + LinkMark("]")
 *   LinkReference    → LinkLabel("[ref]") + LinkMark(":") + URL + LinkTitle?
 *   Image            → LinkMark("![") + content + LinkMark("](") + URL + LinkMark(")")
 */
import { syntaxTree } from '#editor-vendor/codemirror';
import { registerDecorator, Decoration, WidgetType, pushSafeReplace } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

interface ReferenceLinkTarget {
    url: string;
    title: string;
}

const referenceMapCache = new WeakMap<object, Map<string, ReferenceLinkTarget>>();

export function normalizeLinkHref(raw: string): string | null {
    const value = raw.trim();
    if (!value) return null;

    // Allow anchors and site-relative links as-is.
    if (value.startsWith('#') || value.startsWith('/')) return value;

    try {
        const baseHref = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
        const parsed = new URL(value, baseHref);
        const allowed = new Set(['http:', 'https:', 'mailto:', 'tel:', 'file:']);
        if (!allowed.has(parsed.protocol)) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

function stripReferenceLabelBrackets(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
    return trimmed;
}

export function normalizeReferenceLabel(raw: string): string {
    return stripReferenceLabelBrackets(raw)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeLinkTitle(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

export type LinkLabelSegment = { type: 'text' | 'code'; text: string };

function pushLinkLabelTextSegment(segments: LinkLabelSegment[], text: string): void {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous?.type === 'text') {
        previous.text += text;
        return;
    }
    segments.push({ type: 'text', text });
}

function countBacktickRun(value: string, from: number): number {
    let count = 0;
    while (from + count < value.length && value[from + count] === '`') count += 1;
    return count;
}

function findClosingBacktickRun(value: string, from: number, length: number): number {
    for (let index = from; index < value.length; index += 1) {
        if (value[index] !== '`') continue;
        const runLength = countBacktickRun(value, index);
        if (runLength === length) return index;
        index += Math.max(0, runLength - 1);
    }
    return -1;
}

function normalizeInlineCodeText(raw: string): string {
    const normalized = String(raw || '').replace(/[\r\n]+/g, ' ');
    if (/^\s$/.test(normalized)) return normalized;
    if (/^\s[\s\S]*\s$/.test(normalized) && /\S/.test(normalized.slice(1, -1))) {
        return normalized.slice(1, -1);
    }
    return normalized;
}

export function parseLinkLabelSegments(raw: string): LinkLabelSegment[] {
    const value = String(raw || '');
    const segments: LinkLabelSegment[] = [];
    let cursor = 0;

    while (cursor < value.length) {
        const tickIndex = value.indexOf('`', cursor);
        if (tickIndex < 0) {
            pushLinkLabelTextSegment(segments, value.slice(cursor));
            break;
        }
        pushLinkLabelTextSegment(segments, value.slice(cursor, tickIndex));
        const runLength = countBacktickRun(value, tickIndex);
        const codeStart = tickIndex + runLength;
        const codeEnd = findClosingBacktickRun(value, codeStart, runLength);
        if (codeEnd < 0) {
            pushLinkLabelTextSegment(segments, value.slice(tickIndex, codeStart));
            cursor = codeStart;
            continue;
        }
        segments.push({ type: 'code', text: normalizeInlineCodeText(value.slice(codeStart, codeEnd)) });
        cursor = codeEnd + runLength;
    }

    return segments.length ? segments : [{ type: 'text', text: value }];
}

export function appendLinkLabelContent(anchor: HTMLElement, raw: string): void {
    const segments = parseLinkLabelSegments(raw);
    for (const segment of segments) {
        if (segment.type === 'code') {
            const code = document.createElement('code');
            code.className = 'cm-md-inline-code cm-md-link-label-code';
            code.textContent = segment.text;
            anchor.appendChild(code);
            continue;
        }
        anchor.appendChild(document.createTextNode(segment.text));
    }
}

function getReferenceLinks(view: EditorView): Map<string, ReferenceLinkTarget> {
    const doc = view.state.doc;
    const cached = referenceMapCache.get(doc as unknown as object);
    if (cached) return cached;

    const references = new Map<string, ReferenceLinkTarget>();
    syntaxTree(view.state).iterate({
        enter(nodeRef) {
            if (nodeRef.type.name !== 'LinkReference') return;
            const node = nodeRef.node;
            let labelNode: SyntaxNode | null = null;
            let urlNode: SyntaxNode | null = null;
            let titleNode: SyntaxNode | null = null;

            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.type.name === 'LinkLabel' && !labelNode) labelNode = child;
                else if (child.type.name === 'URL') urlNode = child;
                else if (child.type.name === 'LinkTitle') titleNode = child;
            }

            if (!labelNode || !urlNode) return;
            const label = normalizeReferenceLabel(doc.sliceString(labelNode.from, labelNode.to));
            if (!label || references.has(label)) return;
            references.set(label, {
                url: doc.sliceString(urlNode.from, urlNode.to),
                title: titleNode ? normalizeLinkTitle(doc.sliceString(titleNode.from, titleNode.to)) : '',
            });
        },
    });

    referenceMapCache.set(doc as unknown as object, references);
    return references;
}

class LinkWidget extends WidgetType {
    text: string;
    rawUrl: string;
    title: string;

    constructor(text: string, rawUrl: string, title = '') {
        super();
        this.text = text;
        this.rawUrl = rawUrl;
        this.title = title;
    }

    toDOM(): HTMLElement {
        const anchor = document.createElement('a');
        anchor.className = 'cm-md-link cm-md-link-widget';
        appendLinkLabelContent(anchor, this.text || this.rawUrl);

        const href = normalizeLinkHref(this.rawUrl);
        if (href) {
            anchor.href = href;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
        } else {
            anchor.href = '#';
            anchor.classList.add('cm-md-link-invalid');
        }

        anchor.title = this.title || this.rawUrl;

        // Keep editor focus stable; open links intentionally on click.
        anchor.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        anchor.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!href) return;
            window.open(href, '_blank', 'noopener,noreferrer');
        });

        return anchor;
    }

    eq(other: LinkWidget): boolean {
        return this.text === other.text
            && this.rawUrl === other.rawUrl
            && this.title === other.title;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

function resolveReferenceTarget(node: SyntaxNode, view: EditorView, text: string): ReferenceLinkTarget | null {
    let labelNode: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'LinkLabel') {
            labelNode = child;
            break;
        }
    }

    const rawLabel = labelNode ? view.state.doc.sliceString(labelNode.from, labelNode.to) : text;
    const normalizedLabel = normalizeReferenceLabel(rawLabel === '[]' ? text : rawLabel);
    if (!normalizedLabel) return null;
    return getReferenceLinks(view).get(normalizedLabel) || null;
}

function linkDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const marks: SyntaxNode[] = [];
    let urlNode: SyntaxNode | null = null;
    let titleNode: SyntaxNode | null = null;

    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'LinkMark') marks.push(child);
        else if (child.type.name === 'URL') urlNode = child;
        else if (child.type.name === 'LinkTitle') titleNode = child;
    }

    if (marks.length < 2) return [];

    const openMark = marks[0];
    const secondMark = marks[1];
    const textFrom = openMark.to;
    const textTo = secondMark.from;
    const text = view.state.doc.sliceString(textFrom, textTo);
    const directUrl = urlNode ? view.state.doc.sliceString(urlNode.from, urlNode.to) : '';
    const directTitle = titleNode
        ? normalizeLinkTitle(view.state.doc.sliceString(titleNode.from, titleNode.to))
        : '';
    const resolved = urlNode ? { url: directUrl, title: directTitle } : resolveReferenceTarget(node, view, text);
    if (!resolved) return [];

    const entries: DecorationEntry[] = [];
    pushSafeReplace(entries, view.state.doc, node.from, node.to, {
        widget: new LinkWidget(text, resolved.url, resolved.title),
    });
    return entries;
}

function linkReferenceDecorator(node: SyntaxNode, _view: EditorView): DecorationEntry[] {
    return [{
        from: node.from,
        to: node.to,
        decoration: Decoration.mark({ class: 'cm-md-link-reference-def' }),
    }];
}

function imageDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];
    pushSafeReplace(entries, view.state.doc, node.from, node.to);
    return entries;
}

registerDecorator('Link', linkDecorator);
registerDecorator('LinkReference', linkReferenceDecorator);
registerDecorator('Image', imageDecorator);
