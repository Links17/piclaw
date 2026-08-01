export function shouldDisableWhitespaceMarkersForPerformance(input: {
  largeDocumentMode?: boolean;
  livePreviewActive?: boolean;
}): boolean {
  return Boolean(input.largeDocumentMode || input.livePreviewActive);
}

export function getLocalBoolWithFallback(
  getStorage: () => Pick<Storage, "getItem"> | null | undefined,
  key: string,
  fallback: boolean,
): boolean {
  try {
    const value = getStorage()?.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch (_error) {
    return fallback;
  }
  return fallback;
}

export function setLocalBoolBestEffort(
  getStorage: () => Pick<Storage, "setItem"> | null | undefined,
  key: string,
  value: boolean,
): boolean {
  try {
    getStorage()?.setItem(key, value ? "true" : "false");
    return true;
  } catch (_error) {
    return false;
  }
}

export function restoreEditorViewStateBestEffort(
  view: {
    state: { doc: { lines: number; line: (lineNumber: number) => { from: number; length: number } } };
    dispatch: (update: { selection: { anchor: number } }) => void;
    scrollDOM?: { scrollTop: number } | null;
  } | null | undefined,
  viewState: { cursorLine?: number; cursorCol?: number; scrollTop?: number } | null,
  scheduleFrame: (callback: () => void) => void,
): boolean {
  if (!viewState || !view) return false;
  try {
    const { cursorLine, cursorCol, scrollTop } = viewState;
    if (cursorLine && cursorLine > 0 && cursorLine <= view.state.doc.lines) {
      const line = view.state.doc.line(cursorLine);
      const col = Math.min(cursorCol || 1, line.length + 1);
      const pos = line.from + col - 1;
      view.dispatch({ selection: { anchor: pos } });
    }
    if (typeof scrollTop === "number" && scrollTop > 0) {
      scheduleFrame(() => {
        if (view.scrollDOM) view.scrollDOM.scrollTop = scrollTop;
      });
    }
    return true;
  } catch (_error) {
    return false;
  }
}
