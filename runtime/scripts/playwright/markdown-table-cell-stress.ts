import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const runtimeRoot = join(import.meta.dir, '../../');
const staticClassicDist = join(runtimeRoot, 'web/static/classic/dist');
const vendorDir = join(runtimeRoot, 'extensions/viewers/editor/vendor');
const workDir = join(runtimeRoot, '../.seeed/tmp/markdown-table-cell-stress');
mkdirSync(workDir, { recursive: true });

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function buildFixture(): string {
  const rows: string[][] = [
    ['Nested', '**bold _em_** and ***both***', 'nested mark edit target'],
    ['Entities', '&amp; &#169; &#x1f642;', 'entity raw preservation'],
    ['Links', '[docs](https://example.com/docs) and <https://example.com/auto>', 'link interactions'],
    ['Images', '![ok](https://example.com/ok.png) and ![bad](javascript:alert(1))', 'safe image preview only'],
    ['Code', '`alpha` and ~~gone~~', 'code and strike'],
    ['Paste', 'abcdef', 'paste-over-selection target'],
    ['Snake', 'snake_case _em_', 'ambiguous underscore guard'],
  ];
  for (let index = 0; index < 70; index++) {
    rows.push([
      `R${index}`,
      `**strong ${index}** &amp; [link ${index}](https://example.com/${index}) ![img${index}](https://example.com/${index}.png)`,
      `tail ${index}`,
    ]);
  }
  return [
    '# Table cell stress fixture',
    '',
    table(['Kind', 'Value', 'Notes'], rows),
    '',
    'After table.',
  ].join('\n');
}

const source = buildFixture();
const html = `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/static/classic/dist/app.bundle.css">
<script type="importmap">{"imports":{"#editor-vendor/codemirror":"/editor-vendor/codemirror.js"}}</script>
</head><body>
<div id="editor-container" style="width:1600px;height:9000px"></div>
<script type="module">
const editorModule = await import('/static/classic/dist/editor.bundle.js');
const vendor = await import('/editor-vendor/codemirror.js');
const source = ${JSON.stringify(source)};
const editor = new editorModule.StandaloneEditorInstance(document.getElementById('editor-container'), {
  workspace: '/workspace',
  onDirtyChange: () => {},
  emitEvent: () => {},
});
editor.path = '/table-cell-stress.md';
setTimeout(() => {
  editor.setContent(source, new Date().toISOString());
  window.__tableCellStress = { editor, vendor, source };
  window.__tableCellStressReady = true;
}, 200);
</script></body></html>`;
writeFileSync(join(workDir, 'index.html'), html);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(readFileSync(join(workDir, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/editor-vendor/codemirror.js') {
      return new Response(Bun.file(join(vendorDir, 'codemirror.js')), { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    }
    if (url.pathname.startsWith('/static/classic/dist/')) {
      const filePath = join(staticClassicDist, url.pathname.replace('/static/classic/dist/', ''));
      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath), { headers: { 'content-type': filePath.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8' } });
      }
    }
    return new Response(`Not found: ${url.pathname}`, { status: 404 });
  },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 9300 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => (window as any).__tableCellStressReady === true, { timeout: 5_000 });
  await page.waitForTimeout(1_000);

  const result = await page.evaluate(async () => {
    const harness = (window as any).__tableCellStress;
    const view = harness.editor.view;
    const { syntaxTree } = harness.vendor;
    const metrics: Record<string, number> = {};
    const count = (selector: string) => document.querySelectorAll(selector).length;
    const textOf = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).map((el) => el.textContent || '').join(' ');
    const sourceForText = (needle: string) => Array.from(document.querySelectorAll<HTMLElement>('.cm-md-table-cell-source')).find((el) => (el.textContent || '').includes(needle));
    const firstTextNode = (root: Node): Text => {
      if (root.nodeType === Node.TEXT_NODE) return root as Text;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const found = walker.nextNode();
      if (found) return found as Text;
      return root.appendChild(document.createTextNode('')) as Text;
    };
    const setCaret = (node: Node, offset: number) => {
      const text = firstTextNode(node);
      const range = document.createRange();
      range.setStart(text, Math.max(0, Math.min(offset, text.textContent?.length ?? 0)));
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    const insertText = (source: HTMLElement, text: string) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) throw new Error('missing selection for insertText');
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };

    const parserTables: Array<{ from: number; to: number }> = [];
    syntaxTree(view.state).iterate({ enter(node: any) { if (node.name === 'Table') parserTables.push({ from: node.from, to: node.to }); } });

    const renderCounts = {
      parserTables: parserTables.length,
      widgets: count('[data-table-editor]'),
      sources: count('.cm-md-table-cell-source'),
      strong: count('.cm-md-table-cell-strong'),
      em: count('.cm-md-table-cell-em'),
      code: count('.cm-md-table-cell-code'),
      strike: count('.cm-md-table-cell-strike'),
      links: count('.cm-md-table-cell-link'),
      linkIcons: count('.cm-md-table-cell-link-icon'),
      images: count('.cm-md-table-cell-image'),
      entities: count('.cm-md-table-cell-entity'),
      nestedEm: count('.cm-md-table-cell-strong .cm-md-table-cell-em'),
    };

    const openedUrls: string[] = [];
    const originalOpen = window.open;
    window.open = ((url: string) => { openedUrls.push(String(url)); return null; }) as typeof window.open;
    document.querySelector<HTMLElement>('.cm-md-table-cell-link-icon')?.click();
    document.querySelector<HTMLElement>('.cm-md-table-cell-link')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    window.open = originalOpen;

    const nestedSource = sourceForText('**bold _em_**');
    if (!nestedSource) throw new Error('nested source not found');
    const nestedText = nestedSource.querySelector<HTMLElement>('.cm-md-table-cell-strong')?.firstChild;
    if (!nestedText) throw new Error('nested strong text not found');
    let start = performance.now();
    nestedSource.focus();
    setCaret(nestedText, 2);
    insertText(nestedSource, 'X');
    await new Promise((resolve) => setTimeout(resolve, 80));
    metrics.nestedEditMs = performance.now() - start;

    const pasteSource = sourceForText('abcdef');
    if (!pasteSource) throw new Error('paste source not found');
    const pasteText = firstTextNode(pasteSource);
    const range = document.createRange();
    range.setStart(pasteText, 2);
    range.setEnd(pasteText, 4);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', 'M\nN|P');
    start = performance.now();
    pasteSource.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    metrics.pasteEditMs = performance.now() - start;

    const allSources = Array.from(document.querySelectorAll<HTMLElement>('.cm-md-table-cell-source'));
    const editTargets = allSources.slice(30, 90);
    const editTimes: number[] = [];
    for (const source of editTargets) {
      const textNode = firstTextNode(source);
      source.focus();
      setCaret(textNode, Math.min(2, textNode.textContent?.length ?? 0));
      const t0 = performance.now();
      insertText(source, 'z');
      editTimes.push(performance.now() - t0);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    metrics.bulkEditTotalMs = editTimes.reduce((sum, value) => sum + value, 0);
    metrics.bulkEditP95Ms = editTimes.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(editTimes.length * 0.95) - 1)] ?? 0;
    metrics.bulkEditCount = editTimes.length;

    const doc = view.state.doc.toString();
    return {
      renderCounts,
      openedUrls,
      entityText: textOf('.cm-md-table-cell-entity'),
      imageAlts: Array.from(document.querySelectorAll<HTMLImageElement>('.cm-md-table-cell-image')).map((img) => img.alt),
      unsafeImageRendered: Array.from(document.querySelectorAll<HTMLImageElement>('.cm-md-table-cell-image')).some((img) => img.alt === 'bad'),
      visibleDelimiterLeaks: ['**', '***', '__', '___', '~~', '`', '[docs]', '<https://example.com/auto>', '&amp;', '&#169;', '![ok]']
        .filter((needle) => (document.querySelector<HTMLElement>('[data-table-editor]')?.innerText || '').includes(needle)),
      docChecks: {
        nestedPreserved: doc.includes('**boXld _em_**'),
        pasteFlattenedEscaped: doc.includes('abM N\\|Pef'),
        entityRawPreserved: doc.includes('&amp; &#169; &#x1f642;'),
        autolinkRawPreserved: doc.includes('<https://example.com/auto>'),
        imageRawPreserved: doc.includes('![ok](https://example.com/ok.png)'),
      },
      pasteFragment: doc.slice(Math.max(0, doc.indexOf('| Paste |') - 80), doc.indexOf('| Paste |') + 260),
      metrics,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.renderCounts.parserTables === 1, `expected one parser table, got ${result.renderCounts.parserTables}`);
  assert(result.renderCounts.widgets === 1, `expected one table widget, got ${result.renderCounts.widgets}`);
  assert(result.renderCounts.sources >= 200, `expected many editable sources, got ${result.renderCounts.sources}`);
  assert(result.renderCounts.strong >= 60, `expected many strong spans, got ${result.renderCounts.strong}`);
  assert(result.renderCounts.links >= 60, `expected many links, got ${result.renderCounts.links}`);
  assert(result.renderCounts.linkIcons >= 60, `expected many link icons, got ${result.renderCounts.linkIcons}`);
  assert(result.renderCounts.images >= 60, `expected safe image previews, got ${result.renderCounts.images}`);
  assert(result.renderCounts.entities >= 3, `expected entity spans, got ${result.renderCounts.entities}`);
  assert(result.renderCounts.nestedEm >= 1, 'expected nested emphasis inside strong span');
  assert(result.openedUrls.length >= 2, `expected icon and modifier-click opens, got ${JSON.stringify(result.openedUrls)}`);
  assert(result.entityText.includes('&') && result.entityText.includes('©') && result.entityText.includes('🙂'), `entity text missing decoded values: ${result.entityText}`);
  assert(result.imageAlts.includes('ok'), `safe image alt missing: ${JSON.stringify(result.imageAlts)}`);
  assert(!result.unsafeImageRendered, 'unsafe javascript image rendered as <img>');
  assert(result.visibleDelimiterLeaks.length === 0, `resting table text leaked markdown delimiters: ${JSON.stringify(result.visibleDelimiterLeaks)}`);
  assert(Object.values(result.docChecks).every(Boolean), `raw/edit checks failed: ${JSON.stringify(result.docChecks)} fragment=${JSON.stringify(result.pasteFragment)}`);
  assert(result.metrics.bulkEditCount >= 50, `bulk edit count too low: ${result.metrics.bulkEditCount}`);
  assert(result.metrics.bulkEditP95Ms < 25, `bulk edit p95 too slow: ${result.metrics.bulkEditP95Ms}`);
  assert(result.metrics.bulkEditTotalMs < 600, `bulk edit total too slow: ${result.metrics.bulkEditTotalMs}`);

  console.log(`table cell stress ok: ${JSON.stringify({ renderCounts: result.renderCounts, metrics: result.metrics, opens: result.openedUrls.length })}`);
  await browser.close();
} finally {
  server.stop();
}
