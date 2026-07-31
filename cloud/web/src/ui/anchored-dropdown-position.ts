export type DropdownAnchorRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type DropdownBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type ComputeAnchoredDropdownPositionOptions = {
  menuWidth?: number;
  menuMaxHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  margin?: number;
  gap?: number;
  align?: 'left' | 'right';
  clampRect?: DropdownAnchorRect | null;
};

const DEFAULT_MENU_WIDTH = 280;
const DEFAULT_MENU_MAX_HEIGHT = 420;
const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 6;

export function computeAnchoredDropdownPosition(
  buttonRect: DropdownAnchorRect,
  options: ComputeAnchoredDropdownPositionOptions = {},
): { top: number; left: number } {
  const menuWidth = options.menuWidth ?? DEFAULT_MENU_WIDTH;
  const menuMaxHeight = options.menuMaxHeight ?? DEFAULT_MENU_MAX_HEIGHT;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const gap = options.gap ?? DEFAULT_GAP;
  const viewportWidth = options.viewportWidth ?? menuWidth + margin * 2;
  const viewportHeight = options.viewportHeight ?? menuMaxHeight + margin * 2;
  const align = options.align ?? 'right';

  let left = align === 'right'
    ? buttonRect.right - menuWidth
    : buttonRect.left;

  left = Math.max(margin, Math.min(left, viewportWidth - menuWidth - margin));

  const clampRect = options.clampRect;
  if (clampRect) {
    left = Math.max(left, clampRect.left + margin);
    left = Math.min(left, clampRect.right - menuWidth - margin);
  }

  let top = buttonRect.bottom + gap;
  if (top + menuMaxHeight > viewportHeight - margin) {
    const flippedTop = buttonRect.top - gap - menuMaxHeight;
    top = flippedTop >= margin
      ? flippedTop
      : Math.max(margin, viewportHeight - menuMaxHeight - margin);
  }

  return { top, left };
}

export function readDropdownBounds(element: Element | null): DropdownBounds | null {
  if (!element || typeof element.getBoundingClientRect !== 'function') return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}
