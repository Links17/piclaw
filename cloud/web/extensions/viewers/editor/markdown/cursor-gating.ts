/**
 * cursor-gating.ts — Pure helpers for live-preview cursor gating policy.
 *
 * Separated from the CodeMirror plugin so unit tests can validate the
 * node-level gating rules without importing browser/editor modules.
 */

export const BLOCK_CURSOR_GATED_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'Table',
  'HTMLBlock',
]);

export const ALWAYS_DECORATED_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'InlineCode',
  'ListItem',
]);

export function usesBlockCursorGate(name: string): boolean {
  return BLOCK_CURSOR_GATED_NODES.has(name);
}

export function isAlwaysDecoratedNode(name: string): boolean {
  return ALWAYS_DECORATED_NODES.has(name);
}
