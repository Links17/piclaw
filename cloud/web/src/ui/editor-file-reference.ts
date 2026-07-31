export const EDITOR_FILE_REFERENCE_REQUEST_EVENT = 'piclaw:editor-file-reference-request';
export const EDITOR_FILE_REFERENCE_SOURCE = 'editor-footer';

export interface EditorFileReferenceRequestDetail {
  path: string;
  source: typeof EDITOR_FILE_REFERENCE_SOURCE;
}

type EventTargetWindowLike = {
  CustomEvent?: typeof CustomEvent;
  dispatchEvent?: (event: Event) => boolean;
  opener?: unknown;
};

export function normalizeEditorFileReferencePath(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

export function buildEditorFileReferenceRequestDetail(path: unknown): EditorFileReferenceRequestDetail | null {
  const normalizedPath = normalizeEditorFileReferencePath(path);
  if (!normalizedPath) return null;
  return {
    path: normalizedPath,
    source: EDITOR_FILE_REFERENCE_SOURCE,
  };
}

export function getEditorFileReferencePathFromEvent(event: unknown): string {
  return normalizeEditorFileReferencePath((event as { detail?: { path?: unknown } } | null)?.detail?.path);
}

function getSafeOpener(runtimeWindow: EventTargetWindowLike | null | undefined): unknown {
  try {
    return runtimeWindow?.opener || null;
  } catch {
    return null;
  }
}

function dispatchEditorFileReferenceEvent(target: unknown, detail: EditorFileReferenceRequestDetail, fallbackWindow: EventTargetWindowLike | null | undefined): boolean {
  const targetWindow = target as EventTargetWindowLike | null | undefined;
  if (!targetWindow || typeof targetWindow.dispatchEvent !== 'function') return false;

  try {
    const EventCtor = targetWindow.CustomEvent || fallbackWindow?.CustomEvent || globalThis.CustomEvent;
    if (typeof EventCtor !== 'function') return false;
    targetWindow.dispatchEvent(new EventCtor(EDITOR_FILE_REFERENCE_REQUEST_EVENT, { detail }));
    return true;
  } catch {
    return false;
  }
}

export function dispatchEditorFileReferenceRequest(path: unknown, runtimeWindow: EventTargetWindowLike | null | undefined = typeof window !== 'undefined' ? window : null): boolean {
  const detail = buildEditorFileReferenceRequestDetail(path);
  if (!detail) return false;

  let dispatched = dispatchEditorFileReferenceEvent(runtimeWindow, detail, runtimeWindow);
  const opener = getSafeOpener(runtimeWindow);
  if (opener && opener !== runtimeWindow) {
    dispatched = dispatchEditorFileReferenceEvent(opener, detail, runtimeWindow) || dispatched;
  }
  return dispatched;
}
