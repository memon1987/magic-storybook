// FC-027: behavior tests for the pure tablet type/size scale helper and the
// pinned-count (min===max) reuse of computeGrid for the art-style grid.
//
// Both helpers live in useResponsive.ts, whose top-level imports
// (react-native, react-native-safe-area-context) are why the jest-expo preset
// is required — a plain ts-jest/vitest setup can't resolve the module.

import { computeScale, computeGrid, CONTENT_MAX_WIDTH } from '../useResponsive';

describe('computeScale', () => {
  it('returns exactly 1.0 for every phone short edge (< 600)', () => {
    // iPhone SE (320), iPhone 14 (390), iPhone Pro Max (~430), and the
    // boundary just below the tablet split.
    expect(computeScale(320)).toBe(1.0);
    expect(computeScale(390)).toBe(1.0);
    expect(computeScale(430)).toBe(1.0);
    expect(computeScale(599)).toBe(1.0);
  });

  it('is exactly 1.0 at the tablet threshold (600)', () => {
    expect(computeScale(600)).toBe(1.0);
  });

  it('scales iPad mini (744 short edge) to ~1.085', () => {
    // 1 + ((744 - 600) / (1024 - 600)) * 0.25 = 1 + (144/424)*0.25 ≈ 1.0849.
    expect(computeScale(744)).toBeCloseTo(1.085, 3);
  });

  it('reaches the 1.25 cap at iPad Pro 12.9 (1024 short edge)', () => {
    expect(computeScale(1024)).toBe(1.25);
  });

  it('clamps above 1024 to 1.25 (never runs away)', () => {
    expect(computeScale(1366)).toBe(1.25);
    expect(computeScale(5000)).toBe(1.25);
  });

  it('is monotonic across the tablet range', () => {
    expect(computeScale(700)).toBeLessThan(computeScale(800));
    expect(computeScale(800)).toBeLessThan(computeScale(900));
    expect(computeScale(900)).toBeLessThan(computeScale(1024));
  });
});

describe('CONTENT_MAX_WIDTH', () => {
  it('is the 560pt readable content-box cap', () => {
    expect(CONTENT_MAX_WIDTH).toBe(560);
  });
});

describe('computeGrid pinned-count (min === max)', () => {
  it('pins 4-up on a full-width tablet content box → 131pt cells', () => {
    // Art grid on tablet: content box = 560, gap 12, forced 4 columns.
    // cellWidth = (560 - 12*3) / 4 = 524 / 4 = 131.
    const grid = computeGrid(560, { gap: 12, min: 4, max: 4 });
    expect(grid.columns).toBe(4);
    expect(grid.cellWidth).toBe(131);
    expect(grid.gap).toBe(12);
  });

  it('pins 3-up on a typical phone step width → ~106pt cells', () => {
    // iPhone 14 portrait: (390 - 48 container padding) = 342 inner width,
    // gap 12, forced 3 columns. cellWidth = (342 - 12*2)/3 = 318/3 = 106.
    // Matches the old `width: '31%'` cell (31% of 342 ≈ 106).
    const grid = computeGrid(342, { gap: 12, min: 3, max: 3 });
    expect(grid.columns).toBe(3);
    expect(grid.cellWidth).toBe(106);
  });

  it('holds the pinned count even when the raw solve would differ', () => {
    // A very wide box would naturally solve to many columns, but min===max
    // forces exactly 4 — the count never drifts with device width.
    const grid = computeGrid(2000, { gap: 12, min: 4, max: 4 });
    expect(grid.columns).toBe(4);
    // cellWidth still gap-aware: (2000 - 12*3)/4 = 491.
    expect(grid.cellWidth).toBe((2000 - 12 * 3) / 4);
  });
});
