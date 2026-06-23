/**
 * FC-017 Phase 2 — pure types + the persistence contract for the
 * resumable story-generation pipeline.
 *
 * The story Firestore doc is the single source of truth for what's been
 * generated. `JobState` is the in-memory snapshot of that doc that a worker
 * carries through the run. `JobStateWriter` is the persistence side — every
 * phase boundary calls it to commit the artifact to Firestore.
 *
 * Kept in its own module (no Firestore / Gemini / GCS imports) so it's
 * unit-testable and so `gemini.ts` doesn't grow a Firestore dependency.
 */

import { GeneratedStory, GenerationPhase, PageGenerationRecord } from '../types';

/**
 * In-memory snapshot of the story's resume state. Built from the Firestore
 * doc at the start of a run (initial start: mostly empty; resume: populated
 * with whatever the prior worker persisted before dying).
 *
 * imageBase64 fields are populated during a run as artifacts are generated
 * OR re-downloaded from GCS on resume. They are NOT persisted to Firestore
 * (Firestore docs are size-limited; the canonical bytes live in GCS).
 */
export interface JobState {
  storyId: string;
  attempt: number;

  // Phase 1 output. Present means story-text phase is done.
  storyText?: GeneratedStory;

  // Char-ref state. URL persisted; bytes loaded from GCS during a run.
  characterReferenceUrls: Record<string, string>;
  characterRefBytes: Map<string, { data: string; mimeType: string }>;

  // Cast lineup (>1 character only).
  // FC-025 B-6: `castAttempted=true` with `castReferenceUrl=undefined`
  // means "we tried in a prior run and it failed" — don't retry. Without
  // this, null was indistinguishable from "never tried" and retried forever.
  castReferenceUrl?: string;
  castAttempted?: boolean;
  castRefBytes?: { data: string; mimeType: string };

  // Title page. Same attempted-vs-not-tried distinction as cast.
  titlePageImageUrl?: string;
  titleAttempted?: boolean;

  // Per-page state. Keyed by pageNumber-as-string (Firestore map keys must
  // be strings). `bytes` is in-memory only; populated on generation OR
  // re-downloaded from GCS for the K canonical-anchor pages on resume so
  // the parallel batch can still reference them.
  pageUrls: Record<string, PageGenerationRecord>;
  anchorPageBytes: Map<number, { data: string; mimeType: string }>;
}

/** Build an empty JobState (initial start, no resume). */
export function emptyJobState(storyId: string): JobState {
  return {
    storyId,
    attempt: 1,
    characterReferenceUrls: {},
    characterRefBytes: new Map(),
    pageUrls: {},
    anchorPageBytes: new Map(),
  };
}

/**
 * The persistence contract. Implementations either write to Firestore
 * (production) or to an in-memory store (tests). Every method is async
 * because Firestore writes are. All methods are idempotent — writing the
 * same value twice is a no-op.
 *
 * Progress updates are coarser-grained than artifact updates: artifacts
 * are written once per artifact, progress is written once per phase + at
 * intermediate ticks within a phase (e.g. after each char-ref completes).
 */
export interface JobStateWriter {
  /** Persist the LLM-generated story text + character sheets + setting identity. */
  saveStoryText(story: GeneratedStory): Promise<void>;

  /** Persist one character reference URL. Called as each ref completes (not at batch end). */
  saveCharacterReference(name: string, url: string): Promise<void>;

  /** Persist the cast lineup ref URL. Null arg means cast was skipped (e.g. single-character story). */
  saveCastReference(url: string | null): Promise<void>;

  /** Persist the title page URL. Null arg means title-page generation failed (non-fatal). */
  saveTitlePage(url: string | null): Promise<void>;

  /** Persist one page's generated URL + OCR pass status + attempt count. */
  savePage(pageNumber: number, record: PageGenerationRecord): Promise<void>;

  /** Update the live-progress field (phase + completedSteps + totalSteps + message). */
  saveProgress(phase: GenerationPhase, completedSteps: number, totalSteps: number, message: string): Promise<void>;
}

/**
 * Phase 2 stage-message templates. Backend renders the user-facing string
 * so the mobile reader is a dumb subscriber. Keep these short — they
 * appear as the inline progress indicator under the loading state.
 */
export function progressMessage(
  phase: GenerationPhase,
  completedSteps: number,
  totalSteps: number,
  detail?: { charName?: string; pageNumber?: number },
): string {
  switch (phase) {
    case 'queued':
      // FC-031: pre-claim phase. The route writes this on initial set();
      // the worker overwrites it with 'story-text' as soon as claimLock
      // succeeds. progressMessage is currently only called by the worker
      // AFTER claim, so this branch is defensive — but the switch must
      // be exhaustive for type-safety.
      return 'Starting…';
    case 'story-text':
      return 'Writing your story...';
    case 'char-refs':
      // FC-025 L-3: both branches use `completedSteps` (already-done count).
      // Previously the with-charName branch added +1, which read "Drawing
      // Mira... (2 of 3)" right after Mira finished as #1 — off by one.
      return detail?.charName
        ? `Drawing ${detail.charName}... (${completedSteps} of ${totalSteps})`
        : `Drawing characters... (${completedSteps} of ${totalSteps})`;
    case 'cast':
      return 'Drawing the cast lineup...';
    case 'title':
      return 'Painting the cover...';
    case 'anchor-pages':
      return detail?.pageNumber
        ? `Illustrating page ${detail.pageNumber} of ${totalSteps}...`
        : `Illustrating early pages... (${completedSteps} of ${totalSteps})`;
    case 'parallel-pages':
      return detail?.pageNumber
        ? `Illustrating page ${detail.pageNumber} of ${totalSteps}...`
        : `Illustrating pages... (${completedSteps} of ${totalSteps})`;
    case 'finalizing':
      return 'Almost done...';
  }
}
