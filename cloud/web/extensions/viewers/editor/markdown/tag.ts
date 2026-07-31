/**
 * tag.ts — Hashtag inline decorator.
 *
 * Decorates `#tag` patterns as styled pill badges.
 * Uses a custom InlineParser to create HashTag nodes in the lezer tree.
 *
 * Rules:
 * - Must start with `#` preceded by whitespace or start of line
 * - Tag name: letters, digits, hyphens, underscores, slashes (for nested tags)
 * - Must be at least 1 character after `#`
 * - Not inside code spans or headings (handled by tree position)
 */
import { registerDecorator, Decoration } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

// ── Lezer parser extension ──────────────────────────────────────

export const HASHTAG_NODE = 'HashTag';

export const hashtagExtension = {
    defineNodes: [HASHTAG_NODE],
    parseInline: [{
        name: HASHTAG_NODE,
        parse(cx: any, next: number, pos: number): number {
            // Must be `#`
            if (next !== 35 /* # */) return -1;

            // Must be preceded by whitespace, start of line, or start of doc
            if (pos > cx.offset) {
                const prev = cx.char(pos - 1);
                // Allow after whitespace or certain punctuation
                if (prev !== 32 && prev !== 9 && prev !== 10 &&
                    prev !== 40 /* ( */ && prev !== 91 /* [ */ &&
                    prev !== 34 /* " */ && prev !== 39 /* ' */) {
                    return -1;
                }
            }

            // Don't match heading markers (## at start of line)
            const nextCh = cx.char(pos + 1);
            if (nextCh === 35 /* # */ || nextCh === 32 /* space */ || nextCh === -1) return -1;

            // Scan tag name
            let end = pos + 1;
            while (end < cx.end) {
                const ch = cx.char(end);
                // Valid tag chars: letters, digits, -, _, /
                if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || // A-Z, a-z
                    (ch >= 48 && ch <= 57) || // 0-9
                    ch === 45 || ch === 95 || ch === 47) { // - _ /
                    end++;
                } else {
                    break;
                }
            }

            // Must have at least 1 char after #
            if (end <= pos + 1) return -1;

            cx.addElement(cx.elt(HASHTAG_NODE, pos, end));
            return end;
        },
        // Parse before emphasis so #tag isn't eaten by other parsers
        before: 'Emphasis',
    }],
};

// ── Decorator ───────────────────────────────────────────────────

function hashtagDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const text = view.state.doc.sliceString(node.from, node.to);

    return [{
        from: node.from,
        to: node.to,
        decoration: Decoration.mark({ class: 'cm-md-tag' }),
    }];
}

registerDecorator(HASHTAG_NODE, hashtagDecorator);
