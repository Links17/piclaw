/**
 * Editor keystroke profiler — instruments the CM6 editor to measure
 * time spent in each phase of a keystroke cycle.
 *
 * Load this in the browser console when the editor is open:
 *   const profiler = await import('/static/common/js/vendor/editor-profiler.js');
 *   profiler.start();
 *   // Type for a while...
 *   profiler.report();
 *   profiler.stop();
 */

let active = false;
let samples = [];
let origDispatch = null;
let view = null;

export function start() {
  // Find the CM6 editor view
  const cmEl = document.querySelector('.cm-editor');
  if (!cmEl) { console.error('No .cm-editor found'); return; }
  view = cmEl.cmView?.view;
  if (!view) {
    // Try alternate path
    const cmContent = cmEl.querySelector('.cm-content');
    view = cmContent?.cmView?.view ?? window.__cmView;
  }
  if (!view?.dispatch) {
    console.error('Cannot find CM EditorView instance. Expose it as window.__cmView for profiling.');
    return;
  }

  origDispatch = view.dispatch.bind(view);
  active = true;
  samples = [];

  view.dispatch = function profiledDispatch(...args) {
    if (!active) return origDispatch(...args);
    const t0 = performance.now();
    const result = origDispatch(...args);
    const t1 = performance.now();
    const tr = args[0];
    const isDocChange = tr?.changes?.empty === false;
    if (isDocChange) {
      samples.push({
        dispatchMs: t1 - t0,
        docLength: view.state.doc.length,
        timestamp: t0,
      });
    }
    return result;
  };

  // Also measure the updateListener overhead via performance.mark
  console.log('[editor-profiler] Started. Type in the editor, then call report().');
}

export function stop() {
  if (view && origDispatch) {
    view.dispatch = origDispatch;
    origDispatch = null;
  }
  active = false;
  console.log(`[editor-profiler] Stopped. ${samples.length} samples collected.`);
}

export function report() {
  if (samples.length === 0) {
    console.log('[editor-profiler] No samples. Type something first.');
    return;
  }

  const dispatches = samples.map(s => s.dispatchMs);
  dispatches.sort((a, b) => a - b);
  const sum = dispatches.reduce((a, b) => a + b, 0);
  const avg = sum / dispatches.length;
  const p50 = dispatches[Math.floor(dispatches.length * 0.5)];
  const p90 = dispatches[Math.floor(dispatches.length * 0.9)];
  const p99 = dispatches[Math.floor(dispatches.length * 0.99)];
  const max = dispatches[dispatches.length - 1];
  const docLen = samples[samples.length - 1]?.docLength || 0;

  console.table({
    'Samples': samples.length,
    'Doc length': docLen,
    'Avg dispatch (ms)': avg.toFixed(2),
    'P50 (ms)': p50.toFixed(2),
    'P90 (ms)': p90.toFixed(2),
    'P99 (ms)': p99.toFixed(2),
    'Max (ms)': max.toFixed(2),
    'Total dispatch time (ms)': sum.toFixed(1),
  });

  // Flag if janky
  if (p90 > 16) {
    console.warn(`⚠️ P90 dispatch > 16ms (${p90.toFixed(1)}ms) — will cause visible jank at 60fps`);
  }
  if (max > 50) {
    console.warn(`⚠️ Max dispatch ${max.toFixed(1)}ms — long tasks blocking input`);
  }

  return { samples: dispatches.length, avg, p50, p90, p99, max, docLength: docLen };
}

export function getSamples() { return [...samples]; }
