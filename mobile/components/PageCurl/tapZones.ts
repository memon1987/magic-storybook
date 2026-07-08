// FC-040: pure tap-zone router for the reader. Extracted so the zone logic is
// unit-testable without touching Skia/Reanimated (no mobile test runner exists
// yet — FC-024 — but the extraction is required by the plan regardless).
//
// Horizontal zones (Apple Books / Kindle convention, widened center vs the
// pre-FC-035 25/50/25 layout that caused accidental flips):
//   left 20%   → turn backward
//   middle 60% → toggle the reader controls
//   right 20%  → turn forward
//
// Vertical chrome exclusion (FC-040 review fix — HIGH): when the reader controls
// are visible, the top bar (✕) and bottom bar (dots) are live RN Pressables that
// overlap the horizontal turn/toggle zones. The RNGH Tap gesture on the Curl and
// those Pressables are two uncoordinated touch systems, so a tap on the ✕ or a
// dot could ALSO fire a turn/toggle underneath it (the FC-035 overloaded-tap bug
// at the most important control). We exclude the chrome bands here so the Curl
// tap yields 'none' over them and the Pressables own the touch.
//
// INVARIANT: a tap on the ✕ or on a dot must never also turn the page or toggle
// the bars. When controls are hidden there is no chrome to conflict with, so the
// full-height zones turn/toggle as normal.

export type ReaderTapZone = 'backward' | 'toggle' | 'forward' | 'none';

export const BACKWARD_ZONE_RATIO = 0.2;
export const FORWARD_ZONE_RATIO = 0.8;

export interface TapZoneChrome {
  /** Whether the reader control bars are currently visible (and thus live). */
  controlsVisible: boolean;
  /** Rendered height of the top control bar in px (0 if not measured/hidden). */
  topBandHeight: number;
  /** Rendered height of the bottom control bar in px (0 if not measured/hidden). */
  bottomBandHeight: number;
  /** Reader height in px (used to locate the bottom band). */
  height: number;
}

export function resolveTapZone(
  x: number,
  width: number,
  y?: number,
  chrome?: TapZoneChrome
): ReaderTapZone {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 'toggle';

  // Chrome-band exclusion: only when controls are visible (otherwise the bars
  // aren't mounted and can't receive the touch, so the full zones may turn).
  if (
    chrome?.controlsVisible &&
    y != null &&
    Number.isFinite(y) &&
    Number.isFinite(chrome.height)
  ) {
    const inTopBand = chrome.topBandHeight > 0 && y <= chrome.topBandHeight;
    const inBottomBand =
      chrome.bottomBandHeight > 0 && y >= chrome.height - chrome.bottomBandHeight;
    if (inTopBand || inBottomBand) return 'none';
  }

  if (x < width * BACKWARD_ZONE_RATIO) return 'backward';
  if (x > width * FORWARD_ZONE_RATIO) return 'forward';
  return 'toggle';
}
