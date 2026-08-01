/**
 * inline-code.ts — Inline code span decorations.
 *
 * Hides backtick CodeMark nodes and applies monospace styling
 * to the CodeText content.
 *
 * Lezer structure:
 *   InlineCode → CodeMark + CodeText + CodeMark
 */
import { cursorInRange, registerDecorator, Decoration } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

function inlineCodeDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];

    // Find CodeMark children (the backticks)
    const marks: SyntaxNode[] = [];
    let codeText: SyntaxNode | null = null;

    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'CodeMark') {
            marks.push(child);
        } else if (child.type.name === 'CodeText') {
            codeText = child;
        }
    }

    if (marks.length < 2) return entries;

    const openMark = marks[0];
    const closeMark = marks[marks.length - 1];
    const editingThisCodeSpan = cursorInRange(view, node.from, node.to);

    if (!editingThisCodeSpan) {
        // Hide opening backtick(s)
        entries.push({
            from: openMark.from,
            to: openMark.to,
            decoration: Decoration.replace({}),
        });

        // Hide closing backtick(s)
        entries.push({
            from: closeMark.from,
            to: closeMark.to,
            decoration: Decoration.replace({}),
        });
    }

    // Style the code content
    const contentFrom = openMark.to;
    const contentTo = closeMark.from;
    if (contentFrom < contentTo) {
        entries.push({
            from: contentFrom,
            to: contentTo,
            decoration: Decoration.mark({ class: 'cm-md-inline-code' }),
        });
    }

    return entries;
}

registerDecorator('InlineCode', inlineCodeDecorator);
