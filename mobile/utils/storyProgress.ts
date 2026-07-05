/**
 * FC-036: pure progress model for the story-generation loading screen.
 *
 * Maps the REAL Firestore story-doc signals (written by the FC-017 worker —
 * see backend/src/services/worker.ts `FirestoreJobStateWriter` and
 * backend/src/services/gemini.ts) onto a single determinate 0→1 fraction,
 * with asymptotic time-smoothing between real milestones so the bar never
 * visibly stalls but also never claims a milestone that hasn't landed.
 *
 * Signal notes (enumerated from code — do not invent fields):
 *   - `progress.phase` only ever carries: 'queued' (route initial set),
 *     'story-text' (worker), 'char-refs' / 'anchor-pages' / 'parallel-pages'
 *     (gemini.ts per-step ticks), 'finalizing' (worker). The 'cast' and
 *     'title' members of the GenerationPhase union are NEVER written.
 *   - Cast/title completion is observable only via the doc flags
 *     `castAttempted` / `titleAttempted` (FC-025 B-6).
 *   - Per-page completion is observable via the `pageUrls` map growing one
 *     key per page. The service layer exposes only its SIZE
 *     (`pageUrlsCount`) — URLs never reach the UI (no story spoilers).
 *
 * This module is deliberately pure: no React, no Reanimated, no service
 * imports. Everything needed for unit tests (FC-024 runner) is exported.
 */

/** Subset of the story doc that the progress model reads. */
export interface ProgressDocInput {
  status?: string;
  progress?: {
    phase?: string;
    completedSteps?: number;
    totalSteps?: number;
    message?: string;
  };
  childName?: string;
  castAttempted?: boolean;
  titleAttempted?: boolean;
  pageUrlsCount?: number;
  attempt?: number;
}

export interface StoryProgressResult {
  /** Displayed progress in [0, 1]. Callers must clamp monotonic (see clampMonotonic). */
  fraction: number;
  /** Friendly caption for the current milestone. */
  label: string;
  /**
   * Concatenation of the real signals
   * (phase|completedSteps|castAttempted|titleAttempted|pageUrlsCount|attempt).
   * The screen resets its elapsed-in-phase timer whenever this changes.
   */
  milestoneKey: string;
}

/**
 * Mobile mirror of backend getPageCount (backend/src/prompts/story.ts:78).
 * short 4, medium 6, long 8.
 */
export const EXPECTED_PAGES: Record<'short' | 'medium' | 'long', number> = {
  short: 4,
  medium: 6,
  long: 8,
};

/** `EXPECTED_PAGES[length] ?? 6` with undefined/garbage tolerated. */
export function getExpectedPages(length?: string): number {
  if (length && length in EXPECTED_PAGES) {
    return EXPECTED_PAGES[length as keyof typeof EXPECTED_PAGES];
  }
  return 6;
}

/**
 * Milestone band boundaries (fractions). Char-refs gets the dominant share
 * per the FC-016 finding that the char-ref stage is the latency bottleneck
 * (~332s of a ~440s observed run).
 */
export const BANDS = {
  queuedEnd: 0.05,
  storyTextEnd: 0.15,
  charRefsEnd: 0.55,
  castEnd: 0.625,
  titleEnd: 0.7,
  pagesEnd: 0.98,
} as const;

/**
 * Per-band time-smoothing constants (ms). Within a band the displayed
 * fraction creeps asymptotically from the real base `b` toward the next
 * real boundary `n`: b + (n − b) × (1 − e^(−elapsed/τ)) — strictly < n
 * for all finite elapsed, so the creep can never claim an unlanded
 * milestone. Exported for tests; tunable.
 */
export const TAU_MS = {
  queued: 15_000,
  storyText: 30_000,
  charRefs: 90_000,
  castTitle: 25_000,
  perPage: 20_000,
  finalizing: 10_000,
} as const;

/** Fraction shown for a malformed/unrecognized doc. */
export const MALFORMED_FLOOR = 0.05;

/**
 * Monotonic display clamp: the bar may never move backward — including
 * across Resume attempts, where the worker rewinds phases and the raw
 * fraction legitimately drops. Stateless; the caller owns `prev`
 * (e.g. a maxFractionRef).
 */
export function clampMonotonic(prev: number | null | undefined, next: number): number {
  if (typeof prev !== 'number' || Number.isNaN(prev)) return next;
  return next > prev ? next : prev;
}

/** Asymptotic creep from base toward next; never reaches next. */
function smooth(base: number, next: number, elapsedMs: number, tauMs: number): number {
  if (!(next > base) || !(tauMs > 0)) return base;
  const t = Math.max(0, elapsedMs);
  return base + (next - base) * (1 - Math.exp(-t / tauMs));
}

/**
 * Pure progress computation. See module docstring for the band table:
 *
 *   queued      0    → 0.05   phase === 'queued'
 *   story-text  0.05 → 0.15   phase === 'story-text', sub = steps
 *   char-refs   0.15 → 0.55   phase === 'char-refs', sub = steps
 *   cast+title  0.55 → 0.70   castAttempted → 0.625, titleAttempted → 0.70
 *   pages       0.70 → 0.98   0.70 + 0.28 × (pageUrlsCount / expectedPages)
 *   finalize    0.98 → 1.0    phase === 'finalizing'; status 'complete' → 1
 *
 * Malformed/unknown docs floor at MALFORMED_FLOOR with the backend
 * progress.message (final fallback 'Starting…') as the label.
 */
export function computeStoryProgress(
  doc: ProgressDocInput,
  expectedPages: number,
  elapsedInPhaseMs: number,
): StoryProgressResult {
  const phase = doc.progress?.phase;
  const rawTotal = doc.progress?.totalSteps;
  const totalSteps = typeof rawTotal === 'number' && rawTotal > 0 ? rawTotal : 0;
  const rawCompleted = doc.progress?.completedSteps;
  const completedSteps =
    totalSteps > 0 && typeof rawCompleted === 'number'
      ? Math.min(Math.max(rawCompleted, 0), totalSteps)
      : 0;
  const sub = totalSteps > 0 ? completedSteps / totalSteps : 0;
  const castDone = doc.castAttempted === true;
  const titleDone = doc.titleAttempted === true;
  const pagesDone = Math.max(0, doc.pageUrlsCount ?? 0);
  const pageTarget = Math.max(1, Math.floor(expectedPages) || 1);
  const name =
    typeof doc.childName === 'string' && doc.childName.trim() ? doc.childName.trim() : null;

  const milestoneKey = [
    phase ?? 'none',
    completedSteps,
    castDone ? 1 : 0,
    titleDone ? 1 : 0,
    pagesDone,
    doc.attempt ?? 0,
  ].join('|');

  // Terminal success — the only input that maps to exactly 1.0.
  if (doc.status === 'complete') {
    return { fraction: 1, label: 'All done!', milestoneKey };
  }

  if (phase === 'finalizing') {
    return {
      fraction: smooth(BANDS.pagesEnd, 1, elapsedInPhaseMs, TAU_MS.finalizing),
      label: 'Sprinkling the final magic…',
      milestoneKey,
    };
  }

  // Pages band. Entered by real signals only: the page phases, a landed
  // page, or both cast+title flags (base crosses 0.70 only via these).
  const inPagesPhase = phase === 'anchor-pages' || phase === 'parallel-pages';
  if (inPagesPhase || pagesDone > 0 || (castDone && titleDone)) {
    const done = Math.min(pagesDone, pageTarget);
    const span = BANDS.pagesEnd - BANDS.titleEnd; // 0.28
    const base = BANDS.titleEnd + span * (done / pageTarget);
    const next = Math.min(BANDS.titleEnd + span * ((done + 1) / pageTarget), BANDS.pagesEnd);
    const paintingPage = Math.min(done + 1, pageTarget);
    return {
      fraction: smooth(base, next, elapsedInPhaseMs, TAU_MS.perPage),
      label: `Painting page ${paintingPage} of ${pageTarget}…`,
      milestoneKey,
    };
  }

  // Title sub-band: cast landed, title in flight. (Flags, NOT phase —
  // progress.phase still reads 'char-refs' here; see module docstring.)
  if (castDone) {
    return {
      fraction: smooth(BANDS.castEnd, BANDS.titleEnd, elapsedInPhaseMs, TAU_MS.castTitle),
      label: 'Painting the cover…',
      milestoneKey,
    };
  }

  if (phase === 'char-refs') {
    // All refs ticked but castAttempted not yet set → cast in flight.
    if (totalSteps > 0 && completedSteps >= totalSteps) {
      return {
        fraction: smooth(BANDS.charRefsEnd, BANDS.castEnd, elapsedInPhaseMs, TAU_MS.castTitle),
        label: 'Painting the cover…',
        milestoneKey,
      };
    }
    const span = BANDS.charRefsEnd - BANDS.storyTextEnd; // 0.40
    const base = BANDS.storyTextEnd + span * sub;
    const next =
      totalSteps > 0
        ? Math.min(BANDS.storyTextEnd + span * ((completedSteps + 1) / totalSteps), BANDS.charRefsEnd)
        : BANDS.charRefsEnd;
    const counts = totalSteps > 0 ? ` (${completedSteps} of ${totalSteps})` : '';
    return {
      fraction: smooth(base, next, elapsedInPhaseMs, TAU_MS.charRefs),
      label: name ? `Drawing ${name} and friends…${counts}` : `Drawing the characters…${counts}`,
      milestoneKey,
    };
  }

  if (phase === 'story-text') {
    const span = BANDS.storyTextEnd - BANDS.queuedEnd; // 0.10
    const base = BANDS.queuedEnd + span * sub;
    const next =
      totalSteps > 0
        ? Math.min(BANDS.queuedEnd + span * ((completedSteps + 1) / totalSteps), BANDS.storyTextEnd)
        : BANDS.storyTextEnd;
    return {
      fraction: smooth(base, next, elapsedInPhaseMs, TAU_MS.storyText),
      label: name ? `Dreaming up ${name}’s story…` : 'Dreaming up the story…',
      milestoneKey,
    };
  }

  if (phase === 'queued') {
    return {
      fraction: smooth(0, BANDS.queuedEnd, elapsedInPhaseMs, TAU_MS.queued),
      label: 'Warming up the crayons…',
      milestoneKey,
    };
  }

  // Malformed / unknown doc.
  return {
    fraction: MALFORMED_FLOOR,
    label: doc.progress?.message || 'Starting…',
    milestoneKey,
  };
}
