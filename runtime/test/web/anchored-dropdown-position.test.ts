import { describe, expect, test } from 'bun:test';
import { computeAnchoredDropdownPosition } from '../../web/src/ui/anchored-dropdown-position.ts';

describe('computeAnchoredDropdownPosition', () => {
  test('right-aligns dropdown to the button by default', () => {
    const position = computeAnchoredDropdownPosition(
      { top: 8, right: 900, bottom: 36, left: 872 },
      { menuWidth: 280, viewportWidth: 1200, viewportHeight: 800 },
    );

    expect(position.left).toBe(620);
    expect(position.top).toBe(42);
  });

  test('clamps dropdown within container bounds in chat-only layouts', () => {
    const position = computeAnchoredDropdownPosition(
      { top: 8, right: 900, bottom: 36, left: 872 },
      {
        menuWidth: 280,
        viewportWidth: 1200,
        viewportHeight: 800,
        clampRect: { top: 0, left: 300, right: 920, bottom: 800 },
      },
    );

    expect(position.left).toBe(620);
    expect(position.left + 280).toBeLessThanOrEqual(912);
  });

  test('shifts dropdown left when it would overflow the viewport', () => {
    const position = computeAnchoredDropdownPosition(
      { top: 8, right: 1200, bottom: 36, left: 1172 },
      { menuWidth: 280, viewportWidth: 1200, viewportHeight: 800 },
    );

    expect(position.left).toBe(912);
  });

  test('flips dropdown above the button when there is not enough space below', () => {
    const position = computeAnchoredDropdownPosition(
      { top: 760, right: 900, bottom: 788, left: 872 },
      { menuWidth: 280, menuMaxHeight: 420, viewportWidth: 1200, viewportHeight: 800 },
    );

    expect(position.top).toBeLessThan(760);
  });
});
