import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

/**
 * FC-026: minimal responsive layer. Composes useWindowDimensions + safe-area
 * insets into one orientation-aware hook. Intentionally thin — Phase 1 only
 * needs the grid + gutter pieces.
 *
 * FC-027 (Phase 2): completes the FC-026-deferred surface — `scale`
 * (moderate tablet type/size scaling) and `contentMaxWidth` (readable-width
 * cap), each backed by a pure exported helper so consumers on iPad get a
 * centered, capped, gently-scaled layout while phones stay pixel-unchanged.
 */

export type DeviceClass = 'phone' | 'tablet';

// 600dp short-edge is the conventional phone/tablet split: every iPhone is
// < 600 on its short edge, every iPad is >= 600. Using the short edge (min of
// width/height) keeps the classification stable across rotation.
const TABLET_MIN_DIMENSION = 600;

const PHONE_GUTTER = 20;
const TABLET_GUTTER = 32;

/**
 * FC-027: max width of a *content box* (forms, settings sections, wizard
 * steps). Below ~608pt of available width this never binds, so every phone is
 * unaffected; on iPad it caps otherwise-stretched cards at a readable measure.
 * Surfaced through the hook (not just inlined) so a future per-deviceClass
 * value is a one-line change.
 */
export const CONTENT_MAX_WIDTH = 560;

// FC-027 scale curve bounds. Scaling engages only at/above the tablet short
// edge (600) and grows linearly to a hard cap at 1024 (iPad Pro 12.9 short
// edge). Clamp keeps phones at exactly 1.0 and prevents runaway scaling on
// hypothetical >1024 short edges.
const SCALE_MIN = 1.0;
const SCALE_MAX = 1.25;
const SCALE_START_EDGE = 600;
const SCALE_FULL_EDGE = 1024;

export interface GridSpec {
  columns: number;
  cellWidth: number;
  gap: number;
}

export interface GridOptions {
  /** Target cell width in dp; column count is solved to keep cells near this. */
  target?: number;
  /** Gap between columns/rows in dp. */
  gap?: number;
  min?: number;
  max?: number;
}

const DEFAULT_GRID: Required<GridOptions> = {
  target: 178,
  gap: 14,
  min: 2,
  max: 5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure column-count solver — exported for unit testing (FC-024) without a
 * renderer. `available` is the content width already net of gutters + insets.
 */
export function computeGrid(available: number, options: GridOptions = {}): GridSpec {
  const { target, gap, min, max } = { ...DEFAULT_GRID, ...options };
  // Guard pathological widths (e.g. an iPad Slide Over / Stage Manager pane
  // where insets can exceed width) so the column math never goes NaN/negative.
  const safe = Math.max(0, available);
  // Solve N for: N*target + (N-1)*gap <= available  →  N = floor((avail+gap)/(target+gap))
  const raw = Math.floor((safe + gap) / (target + gap));
  const columns = clamp(raw, min, max);
  const cellWidth = Math.max(0, (safe - gap * (columns - 1)) / columns);
  return { columns, cellWidth, gap };
}

/**
 * FC-027: pure type/size scale factor — exported for unit testing without a
 * renderer (same pattern as `computeGrid`). `shortEdge` is the device's short
 * edge (`Math.min(width, height)`) so the factor is orientation-stable, the
 * same convention `isTablet` uses.
 *
 * Returns exactly 1.0 for every phone (`shortEdge < 600`). On tablets it grows
 * linearly from 1.0 at a 600pt short edge to 1.25 at 1024pt (iPad Pro 12.9),
 * clamped to `[1.0, 1.25]`. Examples: iPad mini (744) → ~1.085; iPad Pro 12.9
 * (1024) → 1.25.
 */
export function computeScale(shortEdge: number): number {
  if (shortEdge < SCALE_START_EDGE) return SCALE_MIN;
  const t = (shortEdge - SCALE_START_EDGE) / (SCALE_FULL_EDGE - SCALE_START_EDGE);
  return clamp(SCALE_MIN + t * (SCALE_MAX - SCALE_MIN), SCALE_MIN, SCALE_MAX);
}

export interface Responsive {
  width: number;
  height: number;
  isLandscape: boolean;
  deviceClass: DeviceClass;
  isTablet: boolean;
  /** Horizontal page padding (excludes safe-area insets — add those separately). */
  gutter: number;
  insets: EdgeInsets;
  /** Compute a responsive grid from the current content width. */
  gridColumns: (options?: GridOptions) => GridSpec;
  /**
   * FC-027: type/size scale factor (1.0 on phones, up to 1.25 on iPad Pro).
   * Multiply a small set of named type/size values by this on tablets.
   */
  scale: number;
  /** FC-027: readable-width cap for content boxes (see CONTENT_MAX_WIDTH). */
  contentMaxWidth: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const shortEdge = Math.min(width, height);
  const isLandscape = width > height;
  const isTablet = shortEdge >= TABLET_MIN_DIMENSION;
  const deviceClass: DeviceClass = isTablet ? 'tablet' : 'phone';
  const gutter = isTablet ? TABLET_GUTTER : PHONE_GUTTER;
  const scale = computeScale(shortEdge);

  const gridColumns = (options?: GridOptions): GridSpec => {
    const available = width - gutter * 2 - insets.left - insets.right;
    return computeGrid(available, options);
  };

  return {
    width,
    height,
    isLandscape,
    deviceClass,
    isTablet,
    gutter,
    insets,
    gridColumns,
    scale,
    contentMaxWidth: CONTENT_MAX_WIDTH,
  };
}
