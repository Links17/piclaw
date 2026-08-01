/**
 * emphasis.ts — Bold, italic, and strikethrough decorations.
 *
 * Hides EmphasisMark / StrikethroughMark nodes and applies
 * appropriate styling to the content between them.
 *
 * Lezer structure:
 *   Emphasis      → EmphasisMark + content + EmphasisMark
 *   StrongEmphasis → EmphasisMark + content + EmphasisMark
 *   Strikethrough  → StrikethroughMark + content + StrikethroughMark
 */
import { registerDecorator, Decoration } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

function emphasisDecorator(node: SyntaxNode, _view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];

    // Collect all mark children
    const marks: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'EmphasisMark') {
            marks.push(child);
        }
    }

    // Need at least opening + closing marks
    if (marks.length < 2) return entries;

    const openMark = marks[0];
    const closeMark = marks[marks.length - 1];

    // Hide opening mark
    entries.push({
        from: openMark.from,
        to: openMark.to,
        decoration: Decoration.replace({}),
    });

    // Hide closing mark
    entries.push({
        from: closeMark.from,
        to: closeMark.to,
        decoration: Decoration.replace({}),
    });

    // Style the content between marks
    const contentFrom = openMark.to;
    const contentTo = closeMark.from;
    if (contentFrom < contentTo) {
        entries.push({
            from: contentFrom,
            to: contentTo,
            decoration: Decoration.mark({ class: 'cm-md-em' }),
        });
    }

    return entries;
}

function strongDecorator(node: SyntaxNode, _view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];

    const marks: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'EmphasisMark') {
            marks.push(child);
        }
    }

    if (marks.length < 2) return entries;

    const openMark = marks[0];
    const closeMark = marks[marks.length - 1];

    entries.push({
        from: openMark.from,
        to: openMark.to,
        decoration: Decoration.replace({}),
    });

    entries.push({
        from: closeMark.from,
        to: closeMark.to,
        decoration: Decoration.replace({}),
    });

    const contentFrom = openMark.to;
    const contentTo = closeMark.from;
    if (contentFrom < contentTo) {
        entries.push({
            from: contentFrom,
            to: contentTo,
            decoration: Decoration.mark({ class: 'cm-md-strong' }),
        });
    }

    return entries;
}

function strikethroughDecorator(node: SyntaxNode, _view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];

    const marks: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === 'StrikethroughMark') {
            marks.push(child);
        }
    }

    if (marks.length < 2) return entries;

    const openMark = marks[0];
    const closeMark = marks[marks.length - 1];

    entries.push({
        from: openMark.from,
        to: openMark.to,
        decoration: Decoration.replace({}),
    });

    entries.push({
        from: closeMark.from,
        to: closeMark.to,
        decoration: Decoration.replace({}),
    });

    const contentFrom = openMark.to;
    const contentTo = closeMark.from;
    if (contentFrom < contentTo) {
        entries.push({
            from: contentFrom,
            to: contentTo,
            decoration: Decoration.mark({ class: 'cm-md-strike' }),
        });
    }

    return entries;
}

registerDecorator('Emphasis', emphasisDecorator);
registerDecorator('StrongEmphasis', strongDecorator);
registerDecorator('Strikethrough', strikethroughDecorator);
