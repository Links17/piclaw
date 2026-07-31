export const SUPPORTED_PASTE_IMAGE_TYPES = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function basename(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function getWorkspaceDirectoryForEditorPath(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  return normalized.slice(0, index);
}

function extensionFromName(name: string): string | null {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return null;
  const ext = match[1];
  if (ext === 'jpeg') return 'jpg';
  if (['png', 'jpg', 'webp', 'gif'].includes(ext)) return ext;
  return null;
}

export function getPastedImageExtension(file: Pick<File, 'type' | 'name'> | null | undefined): string | null {
  if (!file) return null;
  const fromType = SUPPORTED_PASTE_IMAGE_TYPES.get(String(file.type || '').toLowerCase());
  if (fromType) return fromType;
  return extensionFromName(file.name || '');
}

export function isSupportedPastedImageFile(file: Pick<File, 'type' | 'name'> | null | undefined): boolean {
  return Boolean(getPastedImageExtension(file));
}

export function getPastedImageFiles(dataTransfer: Pick<DataTransfer, 'files'> | null | undefined): File[] {
  const files = Array.from(dataTransfer?.files || []);
  return files.filter((file) => isSupportedPastedImageFile(file));
}

function markdownFileStem(path: string): string {
  const name = basename(path)
    .replace(/\.markdown$/i, '')
    .replace(/\.md$/i, '')
    .replace(/\.[^.]+$/i, '');
  const safe = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return safe || 'pasted-image';
}

export function formatPasteImageTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function buildPastedImageFilename(
  editorPath: string,
  file: Pick<File, 'type' | 'name'>,
  options: { now?: Date; suffix?: string | number | null } = {},
): string {
  const ext = getPastedImageExtension(file) || 'png';
  const suffix = options.suffix == null || options.suffix === '' ? '' : `-${String(options.suffix).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  return `${markdownFileStem(editorPath)}-${formatPasteImageTimestamp(options.now || new Date())}${suffix}.${ext}`;
}

export function buildMarkdownImageText(filename: string, alt = 'pasted image'): string {
  return `![${alt.replace(/[\[\]]+/g, '').trim() || 'pasted image'}](${filename})`;
}
