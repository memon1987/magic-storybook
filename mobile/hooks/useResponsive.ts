import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

/**
 * FC-026: minimal responsive layer. Composes useWindowDimensions + safe-area
 * insets into one orientation-aware hook. Intentionally thin — Phase 1 only
 * needs the grid + gutter pieces; scale()/contentMaxWidth land in FC-027.
 */

export type DeviceClass = 'phone' | 'tablet';

// 600dp short-edge is the conventional phone/tablet split: every iPhone is
// < 600 on its short edge, every iPad is >= 600. Using the short edge (min of
// width/height) keeps the classification stable across rotation.
const TABLET_MIN_DIMENSION = 600;

const PHONE_GUTTER = 20;
const TABLET_GUTTER = 32;

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
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const isLandscape = width > height;
  const isTablet = Math.min(width, height) >= TABLET_MIN_DIMENSION;
  const deviceClass: DeviceClass = isTablet ? 'tablet' : 'phone';
  const gutter = isTablet ? TABLET_GUTTER : PHONE_GUTTER;

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
  };
}
