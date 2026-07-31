import { keymap, Prec, syntaxTree } from '#editor-vendor/codemirror';
import type { EditorView } from './live-preview.js';

export function isTableBoundaryPosition(tableTo: number, cursorPos: number): boolean {
    return tableTo === cursorPos || tableTo + 1 === cursorPos;
}

function selectTableBeforeCursor(view: EditorView): boolean {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const pos = selection.head;
    if (pos === 0) return false;

    let tableRange: { from: number; to: number } | null = null;
    syntaxTree(view.state).iterate({
        from: Math.max(0, pos - 2),
        to: pos,
        enter(node) {
            if (node.name !== 'Table') return;
            if (!isTableBoundaryPosition(node.to, pos)) return;
            tableRange = { from: node.from, to: node.to };
        },
    });

    if (!tableRange) return false;

    view.dispatch({
        selection: { anchor: tableRange.from, head: tableRange.to },
        scrollIntoView: true,
    });
    return true;
}

export const livePreviewTableKeymap = Prec.high(
    keymap.of([{ key: 'Backspace', run: selectTableBeforeCursor }]),
);
