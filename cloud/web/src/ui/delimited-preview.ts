export type DelimitedPreviewDelimiter = ',' | '\t' | ';' | '|';

export interface DelimitedPreviewOptions {
  delimiter?: DelimitedPreviewDelimiter | null;
  maxRows?: number;
  maxColumns?: number;
}

export interface DelimitedPreviewResult {
  delimiter: DelimitedPreviewDelimiter;
  headers: string[];
  rows: string[][];
  columnCount: number;
  rowCount: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_COLUMNS = 80;
const CANDIDATE_DELIMITERS: DelimitedPreviewDelimiter[] = ['\t', ',', ';', '|'];

function normalizeFilename(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeContentType(value: unknown): string {
  return typeof value === 'string' ? value.split(';')[0]?.trim().toLowerCase() || '' : '';
}

export function isDelimitedAttachment(contentType: unknown, filename?: unknown): boolean {
  const type = normalizeContentType(contentType);
  const name = normalizeFilename(filename);
  return type === 'text/csv'
    || type === 'application/csv'
    || type === 'text/tab-separated-values'
    || type === 'text/tsv'
    || name.endsWith('.csv')
    || name.endsWith('.tsv')
    || name.endsWith('.tab');
}

export function inferDelimitedPreviewDelimiter(contentType: unknown, filename?: unknown): DelimitedPreviewDelimiter | null {
  const type = normalizeContentType(contentType);
  const name = normalizeFilename(filename);
  if (type === 'text/tab-separated-values' || type === 'text/tsv' || name.endsWith('.tsv') || name.endsWith('.tab')) return '\t';
  if (type === 'text/csv' || type === 'application/csv' || name.endsWith('.csv')) return ',';
  return null;
}

function countDelimiterOutsideQuotes(line: string, delimiter: DelimitedPreviewDelimiter): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

function inferDelimiterFromText(text: string): DelimitedPreviewDelimiter {
  const sampleLines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 10);
  let best: { delimiter: DelimitedPreviewDelimiter; score: number } = { delimiter: '\t', score: -1 };
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sampleLines.map((line) => countDelimiterOutsideQuotes(line, delimiter)).filter((count) => count > 0);
    if (!counts.length) continue;
    const common = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const consistency = counts.filter((count) => Math.abs(count - common) < 1).length / counts.length;
    const score = common * consistency * counts.length;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function parseRows(text: string, delimiter: DelimitedPreviewDelimiter, rowLimit: number): { rows: string[][]; truncatedRows: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncatedRows = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    const isTrailingEmptyRow = row.length === 1 && row[0] === '' && rows.length > 0;
    if (!isTrailingEmptyRow) rows.push(row);
    row = [];
    if (rows.length >= rowLimit) truncatedRows = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    if (truncatedRows) break;
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && ch === delimiter) {
      pushField();
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
    } else {
      field += ch;
    }
  }

  if (!truncatedRows && (field.length > 0 || row.length > 0)) pushRow();
  return { rows, truncatedRows };
}

function normalizeRowsToWidth(rows: string[][], width: number): string[][] {
  return rows.map((row) => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  });
}

export function parseDelimitedPreview(text: string, options: DelimitedPreviewOptions = {}): DelimitedPreviewResult {
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
  const maxColumns = Math.max(1, options.maxColumns ?? DEFAULT_MAX_COLUMNS);
  const delimiter = options.delimiter || inferDelimiterFromText(text);
  const parsed = parseRows(text, delimiter, maxRows + 1);
  const visibleRows = parsed.rows.slice(0, maxRows);
  const naturalColumnCount = visibleRows.reduce((max, row) => Math.max(max, row.length), 0);
  const columnCount = Math.min(Math.max(1, naturalColumnCount), maxColumns);
  const truncatedColumns = naturalColumnCount > maxColumns;
  const normalized = normalizeRowsToWidth(visibleRows, columnCount);
  const firstRow = normalized[0] || [];
  const dataRows = normalized.slice(1);
  const hasHeader = firstRow.some((cell) => cell.trim().length > 0) && dataRows.length > 0;
  const headers = hasHeader
    ? firstRow.map((cell, index) => cell.trim() || `Column ${index + 1}`)
    : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const rows = hasHeader ? dataRows : normalized;
  return {
    delimiter,
    headers,
    rows,
    columnCount,
    rowCount: rows.length,
    truncatedRows: parsed.truncatedRows || parsed.rows.length > maxRows,
    truncatedColumns,
  };
}
