// FC-024: behavior tests for the library grid's pure column-count solver.
//
// `computeGrid` decides how many columns the story library renders and how
// wide each cell is. It lives in useResponsive.ts, whose top-level imports
// (react-native, react-native-safe-area-context) are exactly why the
// jest-expo preset is required — a plain ts-jest/vitest setup cannot resolve
// this module without hand-rolled mocks.

import { computeGrid } from '../useResponsive';

describe('computeGrid', () => {
  it('min-clamps a phone width to 2 columns (defaults)', () => {
    // iPhone portrait: 390 window - 2×20 gutter = 350 available.
    // Raw solve: floor((350+14)/(178+14)) = 1 → clamped up to min 2.
    const grid = computeGrid(350);
    expect(grid.columns).toBe(2);
    expect(grid.cellWidth).toBe((350 - 14) / 2); // 168
    expect(grid.gap).toBe(14);
  });

  it('solves 5 columns for a tablet width (defaults)', () => {
    // iPad portrait: 1024 window - 2×32 gutter = 960 available.
    // floor((960+14)/(178+14)) = 5 — within [2, 5], no clamp.
    const grid = computeGrid(960);
    expect(grid.columns).toBe(5);
    expect(grid.cellWidth).toBe((960 - 14 * 4) / 5);
  });

  it('max-clamps a 12.9" iPad landscape width to 5 columns', () => {
    // 1366 window - 2×32 gutter = 1302 available.
    // Raw solve: floor((1302+14)/(178+14)) = 6 → clamped down to max 5.
    const grid = computeGrid(1302);
    expect(grid.columns).toBe(5);
    expect(grid.cellWidth).toBe((1302 - 14 * 4) / 5);
  });

  it('guards pathological negative widths (Slide Over / Stage Manager)', () => {
    // Insets can exceed the pane width; the solver must never emit
    // NaN or negative cell widths.
    const grid = computeGrid(-50);
    expect(grid.columns).toBe(2); // min clamp still applies
    expect(grid.cellWidth).toBe(0);
    expect(Number.isNaN(grid.cellWidth)).toBe(false);
  });

  it('honors option overrides for target, gap, min, and max', () => {
    const grid = computeGrid(600, { target: 100, gap: 10, min: 1, max: 10 });
    // floor((600+10)/(100+10)) = 5 — inside [1, 10].
    expect(grid.columns).toBe(5);
    expect(grid.cellWidth).toBe((600 - 10 * 4) / 5); // 112
    expect(grid.gap).toBe(10);
  });
});
