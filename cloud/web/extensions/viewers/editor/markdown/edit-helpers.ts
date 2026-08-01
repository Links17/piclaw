import {
    EditorSelection,
    EditorView,
    Prec,
    keymap,
    syntaxTree,
} from '#editor-vendor/codemirror';

/**
 * Extend closeBrackets-created emphasis pairs so `*|*` + `*` becomes
 * `**|**` (and the same for underscores). This mirrors Atomic's Obsidian-style
 * bold-pair ergonomics while preserving raw Markdown as source of truth.
 */
export const extendEmphasisPair = Prec.high(
    EditorView.inputHandler.of((view, from, to, text) => {
        if (text !== '*' && text !== '_') return false;
        const { state } = view;
        const selection = state.selection.main;
        if (!selection.empty || from !== to) return false;

        const before = state.doc.sliceString(Math.max(0, from - 1), from);
        const after = state.doc.sliceString(from, Math.min(state.doc.length, from + 1));
        if (before !== text || after !== text) return false;

        view.dispatch({
            changes: { from, insert: text + text },
            selection: { anchor: from + 1 },
        });
        return true;
    }),
);

export function isInsideFencedCodeBeforeLine(doc: string, lineNumber: number): boolean {
    const lines = doc.split('\n');
    let marker: '`' | '~' | null = null;
    let markerLength = 0;

    for (let index = 0; index < lineNumber - 1; index++) {
        const match = lines[index].match(/^ {0,3}(`{3,}|~{3,})/);
        if (!match) continue;

        const currentMarker = match[1][0] as '`' | '~';
        const currentLength = match[1].length;
        if (!marker) {
            marker = currentMarker;
            markerLength = currentLength;
        } else if (currentMarker === marker && currentLength >= markerLength) {
            marker = null;
            markerLength = 0;
        }
    }

    return marker !== null;
}

export function autoCloseCodeFenceInput(
    view: EditorView,
    from: number,
    to: number,
    text: string,
): boolean {
    if (text !== '`' || from !== to) return false;

    const { state } = view;
    const line = state.doc.lineAt(from);
    const before = state.doc.sliceString(line.from, from);
    const after = state.doc.sliceString(from, line.to);
    const match = before.match(/^(\s{0,3})``$/);
    if (!match) return false;
    if (after !== '' && after !== '`') return false;
    if (isInsideFencedCodeBeforeLine(state.doc.toString(), line.number)) return false;

    const indent = match[1];
    const replaceTo = after === '`' ? from + 1 : from;
    const insert = '`\n' + indent + '```';
    view.dispatch({
        changes: { from, to: replaceTo, insert },
        selection: { anchor: from + 1 },
    });
    return true;
}

export const autoCloseCodeFence = Prec.highest(
    EditorView.inputHandler.of(autoCloseCodeFenceInput),
);

function inBulletList(view: EditorView, pos: number): boolean {
    let cursor = syntaxTree(view.state).resolveInner(pos, -1).cursor();
    for (;;) {
        if (cursor.name === 'BulletList') return true;
        if (!cursor.parent()) return false;
    }
}

export function insertTightListItem(view: EditorView): boolean {
    const { state } = view;
    const selection = state.selection.main;
    if (!selection.empty) return false;
    const from = selection.from;
    const line = state.doc.lineAt(from);
    if (!inBulletList(view, from)) return false;

    const lineText = state.doc.sliceString(line.from, line.to);
    const prefix = lineText.match(/^(\s*)([-*+])(\s+)/);
    if (!prefix) return false;

    const [, indent, marker] = prefix;
    const wholePrefix = prefix[0];
    const rest = lineText.slice(wholePrefix.length);
    const taskMatch = rest.match(/^(\[[ xX]\])(\s*)/);
    const taskPrefixLength = taskMatch ? taskMatch[0].length : 0;
    const contentAfterPrefix = rest.slice(taskPrefixLength);

    if (!contentAfterPrefix.trim()) {
        const depth = Math.floor(indent.length / 2);
        if (depth >= 1) {
            const outerIndent = indent.slice(0, indent.length - 2);
            const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
            const replacement = `${outerIndent}${continuation}`;
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: replacement },
                selection: EditorSelection.cursor(line.from + replacement.length),
            });
        } else {
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: '' },
                selection: EditorSelection.cursor(line.from),
            });
        }
        return true;
    }

    const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
    const insert = `\n${indent}${continuation}`;
    view.dispatch({
        changes: { from, to: from, insert },
        selection: EditorSelection.cursor(from + insert.length),
    });
    return true;
}

export const tightListEnterKeymap = Prec.highest(
    keymap.of([{ key: 'Enter', run: insertTightListItem }]),
);
