/**
 * frontmatter.ts — YAML frontmatter parser extension + decorator.
 *
 * Renders frontmatter as a compact 2-column property table:
 *   field (right-aligned pill) | value (left-aligned)
 *
 * Only field labels and tag items are pills.
 */
import { registerDecorator, Decoration, WidgetType } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

// ── Lezer parser extension ──────────────────────────────────────

export const FRONTMATTER_NODE = 'FrontMatter';
export const FRONTMATTER_MARK = 'FrontMatterMark';

export const frontmatterExtension = {
    defineNodes: [
        { name: FRONTMATTER_NODE, block: true },
        { name: FRONTMATTER_MARK },
    ],
    parseBlock: [{
        name: FRONTMATTER_NODE,
        parse(cx: any, line: any): boolean {
            if (cx.parsedPos > 0) return false;
            if (!/^---\s*$/.test(line.text)) return false;

            const openFrom = cx.parsedPos;
            const openTo = openFrom + line.text.length;

            while (cx.nextLine()) {
                if (/^---\s*$/.test(line.text)) {
                    const closeFrom = cx.parsedPos;
                    const closeTo = closeFrom + line.text.length;

                    cx.addElement(cx.elt(FRONTMATTER_NODE, openFrom, closeTo, [
                        cx.elt(FRONTMATTER_MARK, openFrom, openTo),
                        cx.elt(FRONTMATTER_MARK, closeFrom, closeTo),
                    ]));
                    cx.nextLine();
                    return true;
                }
            }
            return false;
        },
        before: 'HorizontalRule',
    }],
};

// ── Value parsing helpers ───────────────────────────────────────

function stripQuotes(value: string): string {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}

function parseInlineYamlList(value: string): string[] {
    const v = value.trim();
    if (!v.startsWith('[') || !v.endsWith(']')) return [];
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner
        .split(',')
        .map((s) => stripQuotes(s))
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseTags(value: string): string[] {
    const list = parseInlineYamlList(value);
    if (list.length) return list;

    // Fallback for comma-separated scalar tags (no brackets).
    if (value.includes(',')) {
        return value
            .split(',')
            .map((s) => stripQuotes(s))
            .map((s) => s.trim())
            .filter(Boolean);
    }

    const single = stripQuotes(value).trim();
    return single ? [single] : [];
}

class FrontmatterRowWidget extends WidgetType {
    field: string;
    value: string;
    tags: string[];

    constructor(field: string, value: string, tags: string[] = []) {
        super();
        this.field = field;
        this.value = value;
        this.tags = tags;
    }

    eq(other: FrontmatterRowWidget): boolean {
        return this.field === other.field && this.value === other.value && JSON.stringify(this.tags) === JSON.stringify(other.tags);
    }

    toDOM(): HTMLElement {
        const row = document.createElement('span');
        row.className = 'cm-md-frontmatter-row';

        const fieldCell = document.createElement('span');
        fieldCell.className = 'cm-md-frontmatter-field-cell';

        const fieldPill = document.createElement('span');
        fieldPill.className = 'cm-md-frontmatter-pill cm-md-frontmatter-field-pill';
        fieldPill.textContent = this.field;
        fieldCell.appendChild(fieldPill);

        const valueCell = document.createElement('span');
        valueCell.className = 'cm-md-frontmatter-value-cell';

        if (this.tags.length > 0) {
            const tagsWrap = document.createElement('span');
            tagsWrap.className = 'cm-md-frontmatter-tags';
            for (const tag of this.tags) {
                const tagPill = document.createElement('span');
                tagPill.className = 'cm-md-frontmatter-pill cm-md-frontmatter-tag-pill';
                tagPill.textContent = tag;
                tagsWrap.appendChild(tagPill);
            }
            valueCell.appendChild(tagsWrap);
        } else {
            const text = document.createElement('span');
            text.className = 'cm-md-frontmatter-value';
            text.textContent = this.value;
            valueCell.appendChild(text);
        }

        row.appendChild(fieldCell);
        row.appendChild(valueCell);
        return row;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

class FrontmatterPlainLineWidget extends WidgetType {
    text: string;

    constructor(text: string) {
        super();
        this.text = text;
    }

    eq(other: FrontmatterPlainLineWidget): boolean {
        return this.text === other.text;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-frontmatter-value';
        span.textContent = this.text;
        return span;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

// ── Decorator ───────────────────────────────────────────────────

function frontmatterDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];
    const doc = view.state.doc;

    const marks: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.type.name === FRONTMATTER_MARK) marks.push(child);
    }

    // Hide opening/closing --- fences entirely
    for (const mark of marks) {
        const line = doc.lineAt(mark.from);
        entries.push({
            from: line.from,
            to: line.to,
            decoration: Decoration.replace({}),
        });
        entries.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({ class: 'cm-md-frontmatter-fence' }),
        });
    }

    if (marks.length < 2) return entries;

    const contentStart = doc.lineAt(marks[0].from).to + 1;
    const contentEnd = marks[marks.length - 1].from;
    if (contentStart >= contentEnd) return entries;

    const lines: { from: number; to: number; text: string }[] = [];
    for (let pos = contentStart; pos < contentEnd; ) {
        const line = doc.lineAt(pos);
        lines.push({ from: line.from, to: line.to, text: line.text });
        pos = line.to + 1;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let cls = 'cm-md-frontmatter-line';
        if (i === 0) cls += ' cm-md-frontmatter-line-first';
        if (i === lines.length - 1) cls += ' cm-md-frontmatter-line-last';
        entries.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({ class: cls }),
        });

        const trimmed = line.text.trim();
        if (!trimmed) continue;

        const match = line.text.match(/^([\w.-][\w\s.-]*?):\s*(.*)$/);
        if (!match) {
            entries.push({
                from: line.from,
                to: line.to,
                decoration: Decoration.replace({ widget: new FrontmatterPlainLineWidget(trimmed) }),
            });
            continue;
        }

        const field = match[1].trim();
        const rawValue = (match[2] || '').trim();
        const isTags = field.toLowerCase() === 'tags';

        const widget = new FrontmatterRowWidget(
            field,
            stripQuotes(rawValue),
            isTags ? parseTags(rawValue) : [],
        );

        entries.push({
            from: line.from,
            to: line.to,
            decoration: Decoration.replace({ widget }),
        });
    }

    return entries;
}

registerDecorator(FRONTMATTER_NODE, frontmatterDecorator);
