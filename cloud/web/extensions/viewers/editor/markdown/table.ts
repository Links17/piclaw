/**
 * table.ts — Table decoration for Markdown live preview.
 *
 * Uses Decoration.line() for row styling and replaces pipe characters
 * with styled separator widgets.
 *
 * Fit-gap parity upgrades:
 * - Column alignment based on delimiter row (:---, ---:, :---:)
 * - Stable per-column min-width inferred from table content
 * - Normalized markdown cell padding
 * - Table editing affordance: clickable/focusable cells jump cursor to source
 */
import { registerDecorator, Decoration, WidgetType } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

type CellAlign = 'left' | 'center' | 'right';

interface CellRenderMeta {
    from: number;
    to: number;
    rawFrom: number;
    rawTo: number;
    text: string;
    className: string;
    style: string;
    col: number;
    row: number;
}

/**
 * Widget that replaces pipe characters.
 * Edge pipes (first/last on a line) → invisible.
 * Inner pipes → thin vertical separator.
 */
class PipeSepWidget extends WidgetType {
    isEdge: boolean;

    constructor(isEdge: boolean) {
        super();
        this.isEdge = isEdge;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = this.isEdge ? 'cm-md-table-edge' : 'cm-md-table-sep';
        return span;
    }

    eq(other: PipeSepWidget): boolean {
        return this.isEdge === other.isEdge;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

class TableCellWidget extends WidgetType {
    text: string;
    className: string;
    style: string;
    sourcePos: number;
    nextPos: number;
    prevPos: number;
    row: number;
    col: number;

    constructor(
        text: string,
        className: string,
        style: string,
        sourcePos: number,
        nextPos: number,
        prevPos: number,
        row: number,
        col: number,
    ) {
        super();
        this.text = text;
        this.className = className;
        this.style = style;
        this.sourcePos = sourcePos;
        this.nextPos = nextPos;
        this.prevPos = prevPos;
        this.row = row;
        this.col = col;
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement('span');
        span.className = `${this.className} cm-md-table-cell-widget`;
        span.setAttribute('style', this.style);
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `Edit table cell row ${this.row + 1}, column ${this.col + 1}`);
        span.textContent = this.text || ' ';

        const jumpTo = (pos: number) => {
            const safe = Math.max(0, Math.min(view.state.doc.length, pos));
            view.dispatch({
                selection: { anchor: safe },
                scrollIntoView: true,
            });
            view.focus();
        };

        span.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            jumpTo(this.sourcePos);
        });
        span.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            jumpTo(this.sourcePos);
        });
        span.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                jumpTo(e.shiftKey ? this.prevPos : this.nextPos);
                return;
            }
            if (e.key === 'Enter' || e.key === 'F2') {
                e.preventDefault();
                e.stopPropagation();
                jumpTo(this.sourcePos);
            }
        });

        return span;
    }

    eq(other: TableCellWidget): boolean {
        return this.text === other.text
            && this.className === other.className
            && this.style === other.style
            && this.sourcePos === other.sourcePos
            && this.nextPos === other.nextPos
            && this.prevPos === other.prevPos
            && this.row === other.row
            && this.col === other.col;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

function tableDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const entries: DecorationEntry[] = [];
    const doc = view.state.doc;

    // Collect all children first to determine last row and delimiter metadata.
    const children: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        children.push(child);
    }

    // Find the last TableRow (for bottom border radius).
    let lastRowNode: SyntaxNode | null = null;
    for (let i = children.length - 1; i >= 0; i--) {
        if (children[i].type.name === 'TableRow') {
            lastRowNode = children[i];
            break;
        }
    }

    // Parse alignment metadata from the delimiter row.
    let columnAlignments: CellAlign[] = [];
    for (const child of children) {
        if (child.type.name === 'TableDelimiter') {
            const delimLine = doc.lineAt(child.from);
            columnAlignments = parseDelimiterAlignments(delimLine.text);
            break;
        }
    }

    // Infer stable column widths from header/body content lengths.
    const columnWidths = inferColumnWidths(children, doc);

    const cells: CellRenderMeta[] = [];
    let bodyRowIndex = 0;
    let visualRow = 0;

    for (const child of children) {
        const name = child.type.name;

        if (name === 'TableDelimiter') {
            // Hide the |---|---| separator row entirely.
            const line = doc.lineAt(child.from);
            entries.push({
                from: line.from,
                to: line.to,
                decoration: Decoration.replace({}),
            });
            entries.push({
                from: line.from,
                to: line.from,
                decoration: Decoration.line({ class: 'cm-md-table-delim-line' }),
            });
        } else if (name === 'TableHeader') {
            // Style header row.
            const line = doc.lineAt(child.from);
            entries.push({
                from: line.from,
                to: line.from,
                decoration: Decoration.line({
                    class: 'cm-md-table-line cm-md-table-header-line',
                }),
            });
            replacePipes(entries, line);
            cells.push(...collectCells(child, doc, columnAlignments, columnWidths, true, visualRow));
            visualRow++;
        } else if (name === 'TableRow') {
            // Style body rows with alternating backgrounds.
            const line = doc.lineAt(child.from);
            const isLast = child === lastRowNode;
            let cls =
                bodyRowIndex % 2 === 0
                    ? 'cm-md-table-line cm-md-table-row-even'
                    : 'cm-md-table-line cm-md-table-row-odd';
            if (isLast) cls += ' cm-md-table-row-last';
            entries.push({
                from: line.from,
                to: line.from,
                decoration: Decoration.line({ class: cls }),
            });
            replacePipes(entries, line);
            cells.push(...collectCells(child, doc, columnAlignments, columnWidths, false, visualRow));
            bodyRowIndex++;
            visualRow++;
        }
    }

    // Emit cell widgets with navigation affordances (Tab / Shift+Tab).
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const next = cells[(i + 1) % cells.length] || cell;
        const prev = cells[(i - 1 + cells.length) % cells.length] || cell;

        if (cell.rawFrom < cell.from) {
            entries.push({
                from: cell.rawFrom,
                to: cell.from,
                decoration: Decoration.replace({}),
            });
        }
        if (cell.to < cell.rawTo) {
            entries.push({
                from: cell.to,
                to: cell.rawTo,
                decoration: Decoration.replace({}),
            });
        }

        entries.push({
            from: cell.from,
            to: cell.to,
            decoration: Decoration.replace({
                widget: new TableCellWidget(
                    cell.text,
                    cell.className,
                    cell.style,
                    cell.from,
                    next.from,
                    prev.from,
                    cell.row,
                    cell.col,
                ),
            }),
        });
    }

    return entries;
}

function inferColumnWidths(children: SyntaxNode[], doc: any): number[] {
    const widths: number[] = [];

    for (const child of children) {
        if (child.type.name !== 'TableHeader' && child.type.name !== 'TableRow') continue;

        let col = 0;
        for (let cell = child.firstChild; cell; cell = cell.nextSibling) {
            if (cell.type.name !== 'TableCell') continue;

            const text = doc.sliceString(cell.from, cell.to).trim();
            const length = Math.max(3, text.length || 0);
            widths[col] = Math.max(widths[col] || 3, length);
            col++;
        }
    }

    return widths.map((w) => Math.min(40, Math.max(3, w)));
}

function parseDelimiterAlignments(lineText: string): CellAlign[] {
    const pieces = lineText
        .split('|')
        .map((p) => p.trim())
        .filter((_, i, arr) => {
            // Drop artificial edge cells from leading/trailing pipes.
            if (arr.length === 0) return false;
            if (i === 0 && arr[i] === '') return false;
            if (i === arr.length - 1 && arr[i] === '') return false;
            return true;
        });

    const aligns: CellAlign[] = [];
    for (const raw of pieces) {
        const startsColon = raw.startsWith(':');
        const endsColon = raw.endsWith(':');

        if (startsColon && endsColon) aligns.push('center');
        else if (endsColon) aligns.push('right');
        else aligns.push('left');
    }

    return aligns;
}

function collectCells(
    rowNode: SyntaxNode,
    doc: any,
    columnAlignments: CellAlign[],
    columnWidths: number[],
    isHeader: boolean,
    row: number,
): CellRenderMeta[] {
    const result: CellRenderMeta[] = [];
    let col = 0;

    for (let cell = rowNode.firstChild; cell; cell = cell.nextSibling) {
        if (cell.type.name !== 'TableCell') continue;

        const { from, to } = trimCellContentRange(doc, cell.from, cell.to);
        const text = from < to ? doc.sliceString(from, to) : '';
        const align = columnAlignments[col] || 'left';
        const widthCh = columnWidths[col] || 3;
        const className = isHeader
            ? `cm-md-table-cell cm-md-table-cell-header cm-md-table-cell-${align}`
            : `cm-md-table-cell cm-md-table-cell-${align}`;

        result.push({
            from,
            to,
            rawFrom: cell.from,
            rawTo: cell.to,
            text,
            className,
            style: `min-width: ${widthCh}ch; text-align: ${align};`,
            col,
            row,
        });

        col++;
    }

    return result;
}

function trimCellContentRange(
    doc: any,
    from: number,
    to: number,
): { from: number; to: number } {
    let start = from;
    let end = to;

    while (start < end) {
        const ch = doc.sliceString(start, start + 1);
        if (ch === ' ' || ch === '\t') start++;
        else break;
    }

    while (end > start) {
        const ch = doc.sliceString(end - 1, end);
        if (ch === ' ' || ch === '\t') end--;
        else break;
    }

    return { from: start, to: end };
}

/**
 * Find all pipe characters in a line and replace them with separator widgets.
 * First and last pipes → invisible edge widget.
 * Inner pipes → thin vertical line separator.
 */
function replacePipes(
    entries: DecorationEntry[],
    line: { from: number; to: number; text: string },
): void {
    const text = line.text;
    const pipes: number[] = [];

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '|') pipes.push(i);
    }

    for (let i = 0; i < pipes.length; i++) {
        const absPos = line.from + pipes[i];
        const isEdge = i === 0 || i === pipes.length - 1;
        entries.push({
            from: absPos,
            to: absPos + 1,
            decoration: Decoration.replace({ widget: new PipeSepWidget(isEdge) }),
        });
    }
}

registerDecorator('Table', tableDecorator);
