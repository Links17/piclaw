export type ScreenSizeHint = 'mobile' | 'tablet' | 'desktop';

function readPositiveNumber(value: unknown): number | null {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasCoarsePointer(win: any): boolean {
  try {
    return Boolean(win?.matchMedia?.('(pointer: coarse)')?.matches);
  } catch {
    return false;
  }
}

function hasMobileUserAgent(win: any): boolean {
  const ua = String(win?.navigator?.userAgent || '');
  return /Android|webOS|iPhone|iPod|Mobile|Windows Phone/i.test(ua);
}

function hasTabletUserAgent(win: any): boolean {
  const ua = String(win?.navigator?.userAgent || '');
  return /iPad|Tablet|PlayBook|Silk/i.test(ua);
}

export function resolveScreenSizeHint(win: any = typeof window !== 'undefined' ? window : null): ScreenSizeHint {
  const width = readPositiveNumber(win?.innerWidth) ?? readPositiveNumber(win?.screen?.availWidth) ?? readPositiveNumber(win?.screen?.width) ?? 0;
  const height = readPositiveNumber(win?.innerHeight) ?? readPositiveNumber(win?.screen?.availHeight) ?? readPositiveNumber(win?.screen?.height) ?? 0;
  const shortest = width && height ? Math.min(width, height) : width || height;
  const longest = width && height ? Math.max(width, height) : width || height;
  const coarse = hasCoarsePointer(win);
  const maxTouchPoints = Number(win?.navigator?.maxTouchPoints || 0);
  const touchLikely = coarse || maxTouchPoints > 1;

  if (shortest > 0 && shortest <= 640) return 'mobile';
  if (hasMobileUserAgent(win) && !hasTabletUserAgent(win)) return 'mobile';
  if (hasTabletUserAgent(win)) return 'tablet';
  if (touchLikely && shortest > 0 && shortest <= 1100) return 'tablet';
  if (longest > 0 && longest <= 1180 && shortest > 0 && shortest <= 900) return 'tablet';
  return 'desktop';
}
