import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const runtimeRoot = join(import.meta.dir, '../../');
const staticClassicDist = join(runtimeRoot, 'web/static/classic/dist');
const vendorDir = join(runtimeRoot, 'extensions/viewers/editor/vendor');
const workDir = join(runtimeRoot, '../.seeed/tmp/markdown-table-late-rendering');
mkdirSync(workDir, { recursive: true });

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function buildFixture(): string {
  const parts: string[] = [
    '# Late table rendering regression',
    '',
    table(['Incident', 'Duration', 'Failure mode', 'Cause'], [
      ['**#1**', '~9 min', 'D-state', 'Startup recovery'],
      ['**#2**', '>15 min', 'R-state', 'CPU loop'],
    ]),
    '',
    '## First timeline',
    '',
    table(['Time', 'Event'], [
      ['~13:55', 'Previous process begins handling chat `web:default:branch:4165db5c5a0f`'],
      ['17:13', '`initDatabase()` opens the SQLite DB'],
      ['17:22', 'Recovery compaction backoff fires'],
    ]),
    '',
    '## Second timeline',
    '',
    table(['Time', 'Event'], [
      ['~17:32', 'Bun file watcher opens many FDs'],
      ['~17:39', '**Main thread enters 100% CPU spin**'],
      ['17:50+', '`curl localhost:8080` times out'],
    ]),
    '',
  ];

  for (let i = 0; i < 70; i++) {
    parts.push(`Filler paragraph ${i}: session context and live preview parsing.`);
    parts.push('');
  }

  parts.push('## Late metrics table');
  parts.push('');
  parts.push(table(['Metric', 'Value', 'Interpretation'], [
    ['State', '`R` (running)', 'Not waiting on I/O or locks'],
    ['syscr/syscw delta', '**0**', 'Zero system calls in 15 min'],
    ['VmRSS delta', '`0`', 'No memory allocation'],
    ['Reference', '[docs](https://example.com)', 'Clickable-looking link rendering'],
    ['Autolink', '<https://example.com/auto>', 'Autolink text interaction'],
    ['Entity', '&amp; &#169; &#x1f642;', 'Entity decoding with raw preservation'],
    ['Image', '![alt](https://example.com/image.png)', 'Inline image preview'],
    ['Nested', '**bold _em_** and ***both***', 'Nested delimiter rendering'],
    ['utime growth', '100 ticks/s', 'Exactly one core saturated'],
  ]));
  parts.push('');
  parts.push('End.');
  return parts.join('\n');
}

const source = buildFixture();
const lateTableNeedle = '| Metric | Value | Interpretation |';
const lateTablePos = source.indexOf(lateTableNeedle);
if (lateTablePos < 0) throw new Error('late table fixture missing metric table');

const html = `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/static/classic/dist/app.bundle.css">
<script type="importmap">{"imports":{"#editor-vendor/codemirror":"/editor-vendor/codemirror.js"}}</script>
</head><body>
<div id="editor-container" style="width:1500px;height:8000px"></div>
<script type="module">
const editorModule = await import('/static/classic/dist/editor.bundle.js');
const vendor = await import('/editor-vendor/codemirror.js');
const source = ${JSON.stringify(source)};
const editor = new editorModule.StandaloneEditorInstance(document.getElementById('editor-container'), {
  workspace: '/workspace',
  onDirtyChange: () => {},
  emitEvent: () => {},
});
editor.path = '/late-table-regression.md';
setTimeout(() => {
  editor.setContent(source, new Date().toISOString());
  window.__lateTableHarness = { editor, vendor, lateTablePos: ${lateTablePos} };
  window.__lateTableReady = true;
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

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 8200 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => (window as any).__lateTableReady === true, { timeout: 5_000 });
  await page.waitForTimeout(1_000);

  const result = await page.evaluate(async () => {
    const harness = (window as any).__lateTableHarness;
    const view = harness.editor.view;
    const { syntaxTree } = harness.vendor;

    const parserTables: Array<{ line: number; from: number; first: string }> = [];
    syntaxTree(view.state).iterate({
      enter(node: any) {
        if (node.name !== 'Table') return;
        parserTables.push({
          line: view.state.doc.lineAt(node.from).number,
          from: node.from,
          first: view.state.doc.sliceString(node.from, Math.min(node.to, node.from + 80)).split('\n')[0],
        });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const widgets = Array.from(document.querySelectorAll('[data-table-editor]')).map((element) => (element.textContent || '').replace(/\s+/g, ' '));
    const rawPipeLines = Array.from(document.querySelectorAll('.cm-line'))
      .map((line) => line.textContent || '')
      .filter((text) => text.includes('| Metric |') || text.includes('| State |') || text.includes('| syscr/syscw delta |'));
    const lateTableInnerText = Array.from(document.querySelectorAll<HTMLElement>('[data-table-editor]'))
      .map((element) => element.innerText || '')
      .find((text) => text.includes('Metric') && text.includes('Interpretation')) ?? '';
    const visibleDelimiterLeaks = ['**', '***', '__', '___', '~~', '`', '[docs]', '<https://example.com/auto>', '&amp;', '&#169;', '![alt]']
      .filter((needle) => lateTableInnerText.includes(needle));

    const openedUrls: string[] = [];
    const originalOpen = window.open;
    window.open = ((url: string) => { openedUrls.push(String(url)); return null; }) as typeof window.open;

    const metricSource = Array.from(document.querySelectorAll<HTMLElement>('.cm-md-table-cell-source'))
      .find((element) => (element.textContent || '').includes('**0**'));
    if (metricSource) {
      const strongWrap = metricSource.querySelector<HTMLElement>('.cm-md-table-cell-strong-wrap');
      const text = strongWrap?.querySelector<HTMLElement>('.cm-md-table-cell-strong')?.firstChild;
      if (text) {
        const range = document.createRange();
        range.setStart(text, 1);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        metricSource.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
      }
    }

    document.querySelector<HTMLElement>('.cm-md-table-cell-link-icon')?.click();
    const linkText = document.querySelector<HTMLElement>('.cm-md-table-cell-link');
    linkText?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    window.open = originalOpen;

    const entityText = Array.from(document.querySelectorAll<HTMLElement>('.cm-md-table-cell-entity')).map((element) => element.textContent).join('');
    const imageAlts = Array.from(document.querySelectorAll<HTMLImageElement>('.cm-md-table-cell-image')).map((image) => image.alt);
    const lateDoc = harness.editor.view.state.doc.toString();
    const markdownClassCounts = {
      source: document.querySelectorAll('.cm-md-table-cell-source').length,
      strong: document.querySelectorAll('.cm-md-table-cell-strong').length,
      code: document.querySelectorAll('.cm-md-table-cell-code').length,
      link: document.querySelectorAll('.cm-md-table-cell-link').length,
      linkIcon: document.querySelectorAll('.cm-md-table-cell-link-icon').length,
      image: document.querySelectorAll('.cm-md-table-cell-image').length,
      entity: document.querySelectorAll('.cm-md-table-cell-entity').length,
      nestedEm: document.querySelectorAll('.cm-md-table-cell-strong .cm-md-table-cell-em').length,
      activeMarkWrap: document.querySelectorAll('.cm-md-table-cell-strong-wrap.active, .cm-md-table-cell-em-wrap.active, .cm-md-table-cell-strike-wrap.active, .cm-md-table-cell-link-wrap.active').length,
    };

    return {
      parserTables,
      widgets,
      rawPipeLines,
      markdownClassCounts,
      openedUrls,
      entityText,
      imageAlts,
      rawPreserved: lateDoc.includes('&amp; &#169; &#x1f642;') && lateDoc.includes('![alt](https://example.com/image.png)') && lateDoc.includes('<https://example.com/auto>'),
      lateTableInnerText,
      visibleDelimiterLeaks,
      lateTablePos: harness.lateTablePos,
      scrollTop: (document.querySelector('.cm-scroller') as HTMLElement | null)?.scrollTop ?? null,
      viewport: (view as any).viewport ?? null,
      firstVisibleLine: (document.querySelector('.cm-line') as HTMLElement | null)?.textContent ?? null,
    };
  });

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join('; ')}`);
  if (result.parserTables.length < 4) throw new Error(`expected parser to find at least 4 tables, found ${result.parserTables.length}`);
  if (!result.widgets.some((text) => text.includes('Metric') && text.includes('Interpretation'))) {
    throw new Error(`late table did not render as editable widget; result=${JSON.stringify(result)}`);
  }
  if (result.rawPipeLines.length > 0) {
    throw new Error(`late table rendered as raw pipe markup: ${JSON.stringify(result.rawPipeLines)}`);
  }
  if (result.markdownClassCounts.source < 1
      || result.markdownClassCounts.strong < 1
      || result.markdownClassCounts.code < 1
      || result.markdownClassCounts.link < 2
      || result.markdownClassCounts.linkIcon < 2
      || result.markdownClassCounts.image < 1
      || result.markdownClassCounts.entity < 3
      || result.markdownClassCounts.nestedEm < 1
      || result.markdownClassCounts.activeMarkWrap < 1) {
    throw new Error(`table cell markdown did not render expected Atomic-style structure/classes: ${JSON.stringify(result.markdownClassCounts)}`);
  }

  if (!result.entityText.includes('&') || !result.entityText.includes('©') || !result.entityText.includes('🙂')) {
    throw new Error(`table cell entities did not decode visibly: ${JSON.stringify(result.entityText)}`);
  }
  if (!result.imageAlts.includes('alt')) {
    throw new Error(`table cell image preview missing expected alt text: ${JSON.stringify(result.imageAlts)}`);
  }
  if (!result.openedUrls.some((url) => url.includes('https://example.com')) || result.openedUrls.length < 2) {
    throw new Error(`table cell link interactions did not open icon and ctrl-click links: ${JSON.stringify(result.openedUrls)}`);
  }
  if (!result.rawPreserved) {
    throw new Error('table cell raw markdown was not preserved for entities/images/autolinks');
  }
  if (result.visibleDelimiterLeaks.length > 0) {
    throw new Error(`table cell resting text leaked markdown delimiters: ${JSON.stringify(result.visibleDelimiterLeaks)} text=${JSON.stringify(result.lateTableInnerText)}`);
  }

  console.log(`late table rendering ok: parserTables=${result.parserTables.length}, visibleWidgets=${result.widgets.length}, markdown=${JSON.stringify(result.markdownClassCounts)}, opens=${result.openedUrls.length}`);
  await browser.close();
} finally {
  server.stop();
}
