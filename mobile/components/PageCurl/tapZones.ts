// FC-040: pure tap-zone router for the reader. Extracted so the zone logic is
// unit-testable without touching Skia/Reanimated (no mobile test runner exists
// yet — FC-024 — but the extraction is required by the plan regardless).
//
// Zones (Apple Books / Kindle convention, widened center vs the pre-FC-035
// 25/50/25 layout that caused accidental flips):
//   left 20%   → turn backward
//   middle 60% → toggle the reader controls
//   right 20%  → turn forward

export type ReaderTapZone = 'backward' | 'toggle' | 'forward';

export const BACKWARD_ZONE_RATIO = 0.2;
export const FORWARD_ZONE_RATIO = 0.8;

export function resolveTapZone(x: number, width: number): ReaderTapZone {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 'toggle';
  if (x < width * BACKWARD_ZONE_RATIO) return 'backward';
  if (x > width * FORWARD_ZONE_RATIO) return 'forward';
  return 'toggle';
}
