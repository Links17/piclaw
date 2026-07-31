# Markdown Live Preview — Spec

## Goal

Add an Obsidian-style live preview mode to piclaw's existing CodeMirror 6 editor for `.md` files. When active, Markdown formatting marks are hidden and content is rendered inline: headings are styled, bold and italic render visually, code blocks get syntax highlighting, and tables render as grids. When the cursor enters a decorated region, the editor reveals the raw Markdown for editing.

The feature is implemented as a set of CM6 extensions that layer on top of `StandaloneEditorInstance`. The editor detects `.md` files, enables the live preview extensions automatically, and shows a toggle button in the status bar.

## Architecture

### Integration point

`editor-extension.ts` (`StandaloneEditorInstance.mountEditor()`) already calls `languageForPath()`, which returns `markdown()` for `.md` files. Add the live preview extensions alongside the existing markdown language support through a new toggleable `Compartment`.

### Core mechanism: cursor-aware decorations

A single `ViewPlugin` (the live preview engine) runs on every document or selection change:

1. Walk the visible syntax tree nodes
2. For each decoratable node, check if the cursor selection overlaps its range
3. If **cursor is inside** → show raw Markdown (no decorations)
4. If **cursor is outside** → apply `Decoration.replace()` to hide marks and `Decoration.widget()`/`Decoration.mark()` for visual rendering

Decorations are **atomic per block**. If the cursor is anywhere inside a heading line, the entire heading shows raw Markdown. This avoids partial-hide states.

### Node type to extension mapping

These node types were confirmed against `@lezer/markdown` 1.6.3 with the GFM extension:

| Lezer Node | Extension | Decoration Type |
|---|---|---|
| `ATXHeading1`–`ATXHeading6` + `HeaderMark` | `heading.ts` | `mark` (style) + `replace` (hide `#` marks) |
| `Emphasis` + `EmphasisMark` | `emphasis.ts` | `mark` (italic) + `replace` (hide `*`/`_`) |
| `StrongEmphasis` + `EmphasisMark` | `emphasis.ts` | `mark` (bold) + `replace` (hide `**`/`__`) |
| `Strikethrough` + `StrikethroughMark` | `emphasis.ts` | `mark` (line-through) + `replace` (hide `~~`) |
| `InlineCode` + `CodeMark` | `inline-code.ts` | `mark` (styled span) + `replace` (hide backticks) |
| `FencedCode` + `CodeMark` + `CodeInfo` + `CodeText` | `code-block.ts` | `widget` (syntax-highlighted block) |
| `Table` + `TableHeader` + `TableRow` + `TableCell` | `table.ts` | `widget` (rendered `<table>`) |
| `Blockquote` + `QuoteMark` | `callout.ts` | `mark` (styled) + callout detection (`[!type]`) |
| `Link` + `Image` + `LinkMark` + `URL` + `LinkTitle` | `link.ts` | Links: `mark` + `replace`; Images: `widget` |
| `BulletList`/`OrderedList` + `ListMark` | `list.ts` | `mark` (styled markers) |
| `Task` + `TaskMarker` | `checkbox.ts` | `widget` (clickable checkbox) |
| `HorizontalRule` | `hr.ts` | `widget` (styled `<hr>`) |

### Custom parser extensions

These features need `@lezer/markdown` `MarkdownConfig` extensions:

| Feature | Parser Approach |
|---|---|
| **Frontmatter** | Custom `BlockParser`: detect `---` at doc start, parse until closing `---` |
| **Footnotes** | Custom `InlineParser` for `[^ref]` + `BlockParser` for `[^ref]: ...` definitions |
| **Tags** | Custom `InlineParser` for `#tag` (word boundary, not inside code) |
| **Callouts** | Detect `[!type]` pattern inside `Blockquote` nodes at decoration time (no parser change needed) |

## File Structure

All new files under `extensions/viewers/editor/`:

```
extensions/viewers/editor/
├── editor-extension.ts          # Modified: add live preview compartment + toggle
├── markdown/
│   ├── live-preview.ts          # Core engine: cursor-aware decoration builder
│   ├── heading.ts               # Heading decorations
│   ├── emphasis.ts              # Bold, italic, strikethrough
│   ├── inline-code.ts           # Inline code spans
│   ├── code-block.ts            # Fenced code block widget
│   ├── table.ts                 # Table widget
│   ├── callout.ts               # Callout/admonition detection + widget
│   ├── link.ts                  # Link/image decorations
│   ├── list.ts                  # List marker styling
│   ├── checkbox.ts              # Task checkbox widget
│   ├── hr.ts                    # Horizontal rule widget
│   ├── frontmatter.ts           # YAML frontmatter parser + widget
│   ├── footnote.ts              # Footnote parser + decorations
│   ├── tag.ts                   # Hashtag parser + decoration
│   └── theme.ts                 # CSS theme for all live preview decorations
└── vendor/
    └── codemirror-entry.ts      # Modified: export additional CM6 APIs needed
```

## Vendor Bundle Changes

The `codemirror-entry.ts` needs additional exports:

```ts
// New exports needed for live preview
export { syntaxTree } from "@codemirror/language";
export { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
export { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
export { parser as markdownParser, GFM, MarkdownConfig } from "@lezer/markdown";
```

Most of these are already in the bundle (just not re-exported). `syntaxTree`, `Decoration`, `ViewPlugin`, `WidgetType` are part of existing dependencies.

## UI

### Status Bar Toggle

Add a `Preview` button next to the existing Vim and Whitespace toggles:
- Only shown for `.md` files
- Default: **on** for `.md` files
- Persisted in `localStorage` as `piclaw_md_live_preview`
- Keyboard shortcut: `Alt+P`

### Visual Design

All decorations use CSS variables from piclaw's theme system:
- Heading sizes: 1.6em / 1.4em / 1.2em / 1.1em / 1.05em / 1em
- Code: `var(--bg-secondary)` background, monospace font
- Blockquote/callout: left border with `var(--accent-color)`
- Table: bordered cells with `var(--border-color)`
- Tags: pill-shaped with `var(--accent-soft)` background
- Formatting marks (when visible): `var(--text-secondary)` color, smaller font

## Implementation Phases

### Phase 1: core and inline formatting
- `live-preview.ts` — cursor-aware decoration engine
- `heading.ts` — heading size + mark hiding
- `emphasis.ts` — bold/italic/strikethrough
- `inline-code.ts` — inline code styling
- `theme.ts` — CSS theme
- Toggle button in status bar
- **Deliverable**: Headings render large, `**bold**` renders bold, etc.

### Phase 2: blocks
- `code-block.ts` — fenced code block widget with syntax highlighting
- `hr.ts` — horizontal rule widget
- `checkbox.ts` — clickable task checkboxes
- `link.ts` — link/image rendering
- `list.ts` — styled list markers
- **Deliverable**: Code blocks, images, checkboxes all render inline

### Phase 3: complex features
- `table.ts` — table widget with tab navigation
- `callout.ts` — callout detection and rendering
- `frontmatter.ts` — YAML frontmatter parser + widget
- `footnote.ts` — footnote parser + widget  
- `tag.ts` — hashtag parser + decoration
- **Deliverable**: Full feature set complete

## Constraints

- All extensions must be **read-compatible**: decorations hide marks visually but the document content remains valid Markdown at all times
- Widgets that modify content (checkbox toggle, table cell edit) must dispatch proper CM6 transactions
- No additional npm dependencies beyond what's already in `devDependencies`
- Must work with existing Vim mode (cursor positioning, visual mode selections)
- Must not break the existing editor for non-Markdown files
- Performance: decorations only computed for visible viewport + small margin
