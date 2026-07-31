/**
 * blockquote-utils.ts — Pure helpers for blockquote/callout detection.
 */

export interface BlockquoteLeadInfo {
  content: string;
  calloutMatch: RegExpMatchArray | null;
}

export function parseBlockquoteLead(lineText: string): BlockquoteLeadInfo {
  const contentMatch = String(lineText || '').match(/^>\s*(.*)$/);
  const content = contentMatch ? contentMatch[1] : '';
  const calloutMatch = content.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)?$/i);
  return { content, calloutMatch };
}

/**
 * Regular blockquotes should keep their decorations even while the cursor is
 * inside them so nested list rendering remains stable. Callouts keep the old
 * editable behavior: when the cursor enters them, the rich decoration backs off
 * so the raw marker syntax can be edited.
 */
export function shouldDecorateBlockquote(lineText: string, cursorInsideBlock: boolean): boolean {
  const { calloutMatch } = parseBlockquoteLead(lineText);
  if (!calloutMatch) return true;
  return !cursorInsideBlock;
}
