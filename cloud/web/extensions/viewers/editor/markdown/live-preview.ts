/**
 * live-preview.ts — Core cursor-aware decoration engine for Markdown live preview.
 *
 * Walks the visible syntax tree and applies decorations to Markdown nodes.
 * When the cursor is inside a node's line, that node shows raw Markdown.
 * When the cursor is elsewhere, formatting marks are hidden and content
 * is rendered with visual styles.
 *
 * Each Markdown feature registers a "decorator" function that receives
 * a syntax node and returns decorations. The engine orchestrates calling
 * them and managing the cursor-aware visibility logic.
 */
import {
    EditorView,
    Decoration,
    ViewPlugin,
    WidgetType,
    RangeSet,
    StateEffect,
    StateField,
    syntaxTree,
} from '#editor-vendor/codemirror';
import type { DecorationSet, Range, ViewUpdate } from '#editor-vendor/codemirror';
import type { SyntaxNode } from '@lezer/common';
import { isAlwaysDecoratedNode, usesBlockCursorGate } from './cursor-gating.js';
import { treeGrowthEffect } from './tree-progress.js';

// ── Types ───────────────────────────────────────────────────────

export interface DecorationEntry {
    from: number;
    to: number;
    decoration: Decoration;
}

/**
 * A decorator function receives a node and the document text,
 * and returns decorations to apply when the cursor is NOT on that line.
 */
export type NodeDecorator = (
    node: SyntaxNode,
    view: EditorView,
) => DecorationEntry[];

// ── Decorator registry ──────────────────────────────────────────

const decorators = new Map<string, NodeDecorator>();

/**
 * Register a decorator for a specific lezer node type name.
 */
export function registerDecorator(nodeType: string, decorator: NodeDecorator): void {
    decorators.set(nodeType, decorator);
}

// ── Utility: check if cursor is in a range ──────────────────────

export function cursorInRange(view: EditorView, from: number, to: number): boolean {
    const sel = view.state.selection;
    for (const range of sel.ranges) {
        if (range.head >= from && range.head <= to) return true;
        const selFrom = Math.min(range.anchor, range.head);
        const selTo = Math.max(range.anchor, range.head);
        if (selFrom <= to && selTo >= from) return true;
    }
    return false;
}

interface LineAddressableDocument {
    length: number;
    lineAt(pos: number): { to: number };
}

export type ReplaceDecorationSpec = Parameters<typeof Decoration.replace>[0];

/**
 * Split a range into same-line segments. CodeMirror rejects plugin-sourced
 * Decoration.replace() ranges that cross line breaks, but Lezer can emit
 * multi-line markdown nodes (for example wrapped link/image titles).
 */
export function splitRangeByDocumentLines(
    doc: LineAddressableDocument,
    from: number,
    to: number,
): Array<{ from: number; to: number }> {
    const docLength = Math.max(0, doc.length);
    let cursor = Math.max(0, Math.min(from, docLength));
    const end = Math.max(0, Math.min(to, docLength));
    const ranges: Array<{ from: number; to: number }> = [];

    while (cursor < end) {
        const line = doc.lineAt(cursor);
        const segmentTo = Math.min(end, line.to);
        if (segmentTo > cursor) {
            ranges.push({ from: cursor, to: segmentTo });
        }
        if (line.to >= end) break;
        cursor = line.to + 1; // leave the line break itself visible
    }

    return ranges;
}

/**
 * Push a Decoration.replace() as one or more same-line DecorationEntry items.
 * If the range spans line breaks, the first segment keeps the widget/spec and
 * later segments become plain hides to avoid duplicated widgets.
 */
export function pushSafeReplace(
    entries: DecorationEntry[],
    doc: LineAddressableDocument,
    from: number,
    to: number,
    spec: ReplaceDecorationSpec = {},
): void {
    let firstSegment = true;
    for (const range of splitRangeByDocumentLines(doc, from, to)) {
        entries.push({
            from: range.from,
            to: range.to,
            decoration: Decoration.replace(firstSegment ? spec : {}),
        });
        firstSegment = false;
    }
}

function getReplaceDecorationSpec(decoration: Decoration): ReplaceDecorationSpec | null {
    const value = decoration as unknown as { isReplace?: boolean; spec?: ReplaceDecorationSpec };
    return value.isReplace ? (value.spec || {}) : null;
}

function pushSplitReplaceRanges(
    ranges: Range<Decoration>[],
    doc: LineAddressableDocument,
    from: number,
    to: number,
    spec: ReplaceDecorationSpec,
): void {
    let firstSegment = true;
    for (const range of splitRangeByDocumentLines(doc, from, to)) {
        ranges.push(Decoration.replace(firstSegment ? spec : {}).range(range.from, range.to));
        firstSegment = false;
    }
}

function pushSafeDecorationRange(
    ranges: Range<Decoration>[],
    doc: LineAddressableDocument,
    from: number,
    to: number,
    decoration: Decoration,
): void {
    if (from === to) {
        ranges.push(decoration.range(from));
        return;
    }

    const crossesLine = doc.lineAt(from).to < to;
    const replaceSpec = getReplaceDecorationSpec(decoration);
    if (replaceSpec && crossesLine) {
        pushSplitReplaceRanges(ranges, doc, from, to, replaceSpec);
    } else {
        ranges.push(decoration.range(from, to));
    }
}

function normalizeReplaceDecorationSet(decorations: DecorationSet, doc: LineAddressableDocument): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    decorations.between(0, doc.length, (from, to, decoration) => {
        pushSafeDecorationRange(ranges, doc, from, to, decoration);
    });
    return RangeSet.of(ranges, true);
}

function changesMayMoveReplaceAcrossLineBreak(update: ViewUpdate): boolean {
    let mayCrossLine = false;
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (mayCrossLine) return;
        if (inserted.toString().includes('\n')) {
            mayCrossLine = true;
            return;
        }
        if (fromA !== toA && update.startState.doc.sliceString(fromA, toA).includes('\n')) {
            mayCrossLine = true;
        }
    });
    return mayCrossLine;
}

// ── ViewPlugin ──────────────────────────────────────────────────

export function getSelectionLineSignature(view: Pick<EditorView, 'state'>): string {
    const doc = view.state.doc;
    return view.state.selection.ranges
        .map((range) => {
            const anchor = Math.max(0, Math.min(range.anchor, doc.length));
            const head = Math.max(0, Math.min(range.head, doc.length));
            return `${doc.lineAt(anchor).from}:${doc.lineAt(head).from}`;
        })
        .join('|');
}

function lineTouchesVisibleRange(line: { from: number; to: number }, view: EditorView): boolean {
    return view.visibleRanges.some((range) => line.from <= range.to && line.to >= range.from);
}

function selectionTouchesVisibleRange(view: EditorView, state: Pick<EditorView['state'], 'doc' | 'selection'>): boolean {
    const doc = state.doc;
    for (const range of state.selection.ranges) {
        const anchor = Math.max(0, Math.min(range.anchor, doc.length));
        const head = Math.max(0, Math.min(range.head, doc.length));
        if (lineTouchesVisibleRange(doc.lineAt(anchor), view)) return true;
        if (lineTouchesVisibleRange(doc.lineAt(head), view)) return true;
    }
    return false;
}

const LIVE_PREVIEW_DEBOUNCE_MS = 220;
const LIVE_PREVIEW_FREEZE_TAIL_MS = 100;
const LIVE_PREVIEW_RANGE_MARGIN_CHARS = 4000;

export const setLivePreviewFrozen = StateEffect.define<boolean>();
export const forceLivePreviewRebuild = StateEffect.define<void>();

export const livePreviewFrozenField = StateField.define<boolean>({
    create: () => false,
    update(value, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setLivePreviewFrozen)) return effect.value;
        }
        return value;
    },
});

function transactionHasFreezeEffect(update: ViewUpdate): boolean {
    return update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setLivePreviewFrozen)),
    );
}

function transactionHasTreeGrowthEffect(update: ViewUpdate): boolean {
    return update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(treeGrowthEffect)),
    );
}

function transactionHasForceRebuildEffect(update: ViewUpdate): boolean {
    return update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(forceLivePreviewRebuild)),
    );
}

class LivePreviewPointerFreezePlugin {
    private pointerDown = false;
    private releaseTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Node) || !this.view.contentDOM.contains(target)) return;

        this.pointerDown = true;
        if (this.releaseTimer !== null) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
        if (!this.view.state.field(livePreviewFrozenField, false)) {
            this.view.dispatch({ effects: setLivePreviewFrozen.of(true) });
        }
    };

    private readonly onPointerUp = () => {
        if (!this.pointerDown) return;
        this.pointerDown = false;
        if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
        this.releaseTimer = setTimeout(() => {
            this.releaseTimer = null;
            if (!this.view.state.field(livePreviewFrozenField, false)) return;
            try {
                this.view.dispatch({ effects: setLivePreviewFrozen.of(false) });
            } catch (error) {
                console.debug('[editor/live-preview] ignored freeze release after view disposal', error);
            }
        }, LIVE_PREVIEW_FREEZE_TAIL_MS);
    };

    constructor(private readonly view: EditorView) {
        // Capture phase ensures freeze is active before CM6 handles pointer-driven
        // selection changes that would otherwise reveal markdown syntax mid-click.
        view.dom.addEventListener('pointerdown', this.onPointerDown, true);
        window.addEventListener('pointerup', this.onPointerUp);
        window.addEventListener('pointercancel', this.onPointerUp);
    }

    destroy() {
        this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
        window.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointercancel', this.onPointerUp);
        if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    }
}

export const livePreviewPointerFreeze = ViewPlugin.fromClass(LivePreviewPointerFreezePlugin);

const MID_TYPING_DELIMITERS: readonly Array<{ delim: string; className: string }> = [
    { delim: '**', className: 'cm-md-strong' },
    { delim: '__', className: 'cm-md-strong' },
    { delim: '~~', className: 'cm-md-strike' },
    { delim: '*', className: 'cm-md-em' },
    { delim: '_', className: 'cm-md-em' },
];

function indexOfUnconsumed(text: string, search: string, from: number, consumed: Uint8Array): number {
    let index = text.indexOf(search, from);
    while (index >= 0) {
        let free = true;
        for (let offset = 0; offset < search.length; offset++) {
            if (consumed[index + offset]) {
                free = false;
                break;
            }
        }
        if (free) return index;
        index = text.indexOf(search, index + 1);
    }
    return -1;
}

export function findMidTypingEmphasisRanges(
    text: string,
    lineFrom: number,
    localCursor: number,
): Array<{ from: number; to: number; className: string }> {
    const ranges: Array<{ from: number; to: number; className: string }> = [];
    const consumed = new Uint8Array(text.length);

    for (const { delim, className } of MID_TYPING_DELIMITERS) {
        const delimLength = delim.length;
        const isUnderscore = delim === '_' || delim === '__';
        let searchFrom = 0;
        while (searchFrom < text.length) {
            const open = indexOfUnconsumed(text, delim, searchFrom, consumed);
            if (open < 0) break;
            if (isUnderscore && open > 0 && /\w/.test(text[open - 1])) {
                searchFrom = open + delimLength;
                continue;
            }
            const close = indexOfUnconsumed(text, delim, open + delimLength, consumed);
            if (close < 0) break;
            if (isUnderscore && close + delimLength < text.length && /\w/.test(text[close + delimLength])) {
                searchFrom = close + delimLength;
                continue;
            }

            for (let index = open; index < close + delimLength; index++) consumed[index] = 1;
            const contentFrom = open + delimLength;
            const contentTo = close;
            if (contentFrom < contentTo && localCursor > open && localCursor < close + delimLength) {
                ranges.push({
                    from: lineFrom + contentFrom,
                    to: lineFrom + contentTo,
                    className,
                });
            }
            searchFrom = close + delimLength;
        }
    }

    return ranges;
}

function addMidTypingEmphasisEntries(entries: DecorationEntry[], view: EditorView): void {
    if (!view.hasFocus) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const ranges = findMidTypingEmphasisRanges(line.text, line.from, head - line.from);
    for (const range of ranges) {
        entries.push({
            from: range.from,
            to: range.to,
            decoration: Decoration.mark({ class: range.className }),
        });
    }
}

interface DecorationBuildRange {
    from: number;
    to: number;
}

function mergeBuildRanges(ranges: DecorationBuildRange[]): DecorationBuildRange[] {
    if (ranges.length <= 1) return ranges;
    const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: DecorationBuildRange[] = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && range.from <= previous.to + 1) {
            previous.to = Math.max(previous.to, range.to);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

function getLivePreviewVisibleLineRanges(view: EditorView): DecorationBuildRange[] {
    const doc = view.state.doc;
    const docLength = doc.length;
    const visible = view.visibleRanges.length > 0 ? view.visibleRanges : [{ from: 0, to: docLength }];
    const ranges: DecorationBuildRange[] = visible.map((range) => ({
        from: doc.lineAt(Math.max(0, Math.min(range.from, docLength))).from,
        to: doc.lineAt(Math.max(0, Math.min(range.to, docLength))).to,
    }));

    for (const selection of view.state.selection.ranges) {
        const anchor = Math.max(0, Math.min(selection.anchor, docLength));
        const head = Math.max(0, Math.min(selection.head, docLength));
        const fromLine = doc.lineAt(Math.min(anchor, head));
        const toLine = doc.lineAt(Math.max(anchor, head));
        ranges.push({ from: fromLine.from, to: toLine.to });
    }

    return mergeBuildRanges(ranges);
}

export function getLivePreviewDecorationRanges(view: EditorView): DecorationBuildRange[] {
    const doc = view.state.doc;
    const docLength = doc.length;
    const visible = view.visibleRanges.length > 0 ? view.visibleRanges : [{ from: 0, to: docLength }];
    const ranges: DecorationBuildRange[] = visible.map((range) => {
        const from = Math.max(0, range.from - LIVE_PREVIEW_RANGE_MARGIN_CHARS);
        const to = Math.min(docLength, range.to + LIVE_PREVIEW_RANGE_MARGIN_CHARS);
        return {
            from: doc.lineAt(from).from,
            to: doc.lineAt(to).to,
        };
    });

    // Include selection endpoints even if CM temporarily reports a stale or tiny
    // visible range during programmatic reveal/focus changes.
    for (const selection of view.state.selection.ranges) {
        const anchor = Math.max(0, Math.min(selection.anchor, docLength));
        const head = Math.max(0, Math.min(selection.head, docLength));
        const fromLine = doc.lineAt(Math.min(anchor, head));
        const toLine = doc.lineAt(Math.max(anchor, head));
        ranges.push({ from: fromLine.from, to: toLine.to });
    }

    return mergeBuildRanges(ranges);
}

export function livePreviewRangesCover(cached: DecorationBuildRange[], required: DecorationBuildRange[]): boolean {
    return required.every((range) => cached.some((cachedRange) => cachedRange.from <= range.from && cachedRange.to >= range.to));
}

class LivePreviewPlugin {
    decorations: DecorationSet;
    private selectionLineSignature: string;
    private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private view: EditorView;
    private decorationRanges: DecorationBuildRange[] = [];
    private destroyed = false;

    constructor(view: EditorView) {
        this.view = view;
        this.selectionLineSignature = getSelectionLineSignature(view);
        this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
        this.view = update.view;
        const nextSelectionLineSignature = getSelectionLineSignature(update.view);
        const selectionLineChanged = nextSelectionLineSignature !== this.selectionLineSignature;
        this.selectionLineSignature = nextSelectionLineSignature;

        const frozen = update.state.field(livePreviewFrozenField, false);
        const freezeReleased = transactionHasFreezeEffect(update) && !frozen;
        const treeGrew = transactionHasTreeGrowthEffect(update);
        const forceRebuild = transactionHasForceRebuildEffect(update);

        const selectionIsCollapsed = update.state.selection.ranges.every((range) => range.empty);
        const selectionTouchesViewport = update.selectionSet && (
            selectionTouchesVisibleRange(update.view, update.startState) ||
            selectionTouchesVisibleRange(update.view, update.state)
        );
        const viewportNowShowsSelection = update.viewportChanged && selectionTouchesVisibleRange(update.view, update.state);
        const viewportRequiresRebuild = update.viewportChanged
            && !livePreviewRangesCover(this.decorationRanges, getLivePreviewVisibleLineRanges(update.view));

        const needsRebuild =
            update.docChanged ||
            viewportRequiresRebuild ||
            forceRebuild ||
            treeGrew ||
            freezeReleased ||
            (!frozen && (
                (update.selectionSet && selectionIsCollapsed && selectionLineChanged && selectionTouchesViewport) ||
                viewportNowShowsSelection
            ));

        if (!needsRebuild) return;

        if (update.docChanged) {
            // During typing: keep existing decorations positionally valid while
            // debouncing the expensive full rebuild. Returning stale ranges after
            // an insertion can make an old replace span a new line break.
            const mappedDecorations = this.decorations.map(update.changes);
            this.decorations = changesMayMoveReplaceAcrossLineBreak(update)
                ? normalizeReplaceDecorationSet(mappedDecorations, update.state.doc)
                : mappedDecorations;
            if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
            if (forceRebuild) {
                this.decorations = this.buildDecorations(update.view);
                return;
            }
            this.rebuildTimer = setTimeout(() => {
                this.rebuildTimer = null;
                if (this.destroyed) return;
                try {
                    this.view.dispatch({ effects: forceLivePreviewRebuild.of() });
                } catch (error) {
                    console.debug('[editor/live-preview] ignored delayed rebuild after view disposal', error);
                }
            }, LIVE_PREVIEW_DEBOUNCE_MS);
        } else if (forceRebuild) {
            if (this.rebuildTimer !== null) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
            this.decorations = this.buildDecorations(update.view);
        } else {
            // Viewport/selection changes: rebuild immediately (no typing lag)
            if (this.rebuildTimer !== null) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
            this.decorations = this.buildDecorations(update.view);
        }
    }

    destroy() {
        this.destroyed = true;
        if (this.rebuildTimer !== null) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    }

    private buildDecorations(view: EditorView): DecorationSet {
        const tree = syntaxTree(view.state);
        const entries: DecorationEntry[] = [];
        const doc = view.state.doc;
        const cursorHead = view.state.selection.main.head;
        const cursorLine = doc.lineAt(cursorHead);
        const buildRanges = getLivePreviewDecorationRanges(view);
        this.decorationRanges = buildRanges;

        for (const buildRange of buildRanges) {
            tree.iterate({
                from: buildRange.from,
                to: buildRange.to,
                enter(node) {
                    const nodeTypeName = node.type.name;
                    const decorator = decorators.get(nodeTypeName);
                    if (!decorator) return;

                    const isFrontmatter = nodeTypeName === 'FrontMatter';
                    const isBlock = usesBlockCursorGate(nodeTypeName);
                    const alwaysDecorate = isAlwaysDecoratedNode(nodeTypeName);

                    if (!isFrontmatter && !alwaysDecorate) {
                        if (isBlock) {
                            // For block nodes: check if cursor's LINE is inside the block.
                            // Use line-level granularity so only the active line shows raw MD,
                            // not the entire multi-line block.
                            if (cursorLine.from >= node.from && cursorLine.from <= node.to) {
                                return;
                            }
                        } else {
                            // For inline nodes: check if cursor is on the same line.
                            const checkFrom = doc.lineAt(node.from).from;
                            const safeTo = Math.max(node.from, Math.min(node.to, doc.length));
                            const checkTo = doc.lineAt(safeTo).to;
                            if (cursorInRange(view, checkFrom, checkTo)) return;
                        }
                    }

                    const decos = decorator(node.node, view);
                    entries.push(...decos);

                    // Code-font: add line decorations for code block lines
                    // (merged from code-font.ts to avoid a second tree walk)
                    if (nodeTypeName === 'FencedCode' || nodeTypeName === 'CodeBlock') {
                        const startLine = doc.lineAt(node.from).number;
                        const endPos = Math.max(node.from, Math.min(node.to, doc.length) - 1);
                        const endLine = doc.lineAt(endPos).number;
                        for (let ln = startLine; ln <= endLine; ln++) {
                            const line = doc.line(ln);
                            entries.push({
                                from: line.from,
                                to: line.from,
                                decoration: Decoration.line({ class: 'cm-md-code-raw-line' }),
                            });
                        }
                    }
                },
            });
        }

        addMidTypingEmphasisEntries(entries, view);

        // Convert entries to Range<Decoration> and use RangeSet.of()
        // which handles sorting automatically (unlike RangeSetBuilder).
        const ranges: Range<Decoration>[] = [];
        for (const entry of entries) {
            if (entry.from > entry.to) continue; // skip invalid (but allow point decos: from === to)
            try {
                pushSafeDecorationRange(ranges, doc, entry.from, entry.to, entry.decoration);
            } catch (error) {
                console.warn('[editor/live-preview] skipped invalid decoration range', {
                    from: entry.from,
                    to: entry.to,
                    error: error instanceof Error ? error.message : String(error || 'Unknown error'),
                });
            }
        }

        return RangeSet.of(ranges, true);
    }
}

/**
 * The ViewPlugin for live preview. Import and add to extensions array.
 */
export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (v) => v.decorations,
});

// ── Re-exports for decorator implementations ───────────────────

export { Decoration, WidgetType };
export type { EditorView, SyntaxNode };
