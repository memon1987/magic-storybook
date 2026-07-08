/**
 * FC-017 Phase 2 — `runStoryWorker` is the single entry point for both initial
 * generation (called by POST /api/stories/generate) and resume (called by
 * POST /api/stories/:id/resume).
 *
 * Contract:
 *  - The story Firestore doc must already exist with at least `userId`,
 *    inputs (childName, setting, moral, length, artStyle, etc.), and
 *    `status: 'queued'` (initial) or `status: 'failed' | 'generating'` (resume).
 *  - Claims the doc transactionally via workerId + workerHeartbeatAt. If
 *    another live worker holds it (heartbeat younger than 90s), throws
 *    `LockHeldError` and the caller returns 409 Conflict.
 *  - Loads JobState from whatever the doc has persisted so far.
 *  - Runs the (resume-aware) pipeline: generateStory → generateAllIllustrations.
 *  - Each phase boundary writes its artifact via FirestoreJobStateWriter.
 *  - On terminal success: writes the pages subcollection + final
 *    `status: 'complete'` + clears workerId. Returns the assembled story.
 *  - On terminal failure: SINGLE atomic update writes
 *    `status: 'failed'` + sanitized failureReason + clears workerId.
 *  - Heartbeat: HeartbeatController (self-scheduling setTimeout with .unref())
 *    refreshes workerHeartbeatAt every 15s; stop() awaits any in-flight refresh
 *    so a terminal commit's lock-clear isn't races-resurrected by a late tick.
 *
 * FC-025 remediations applied:
 *   B-1 same-process lock-reentry race  → drop self-skip + in-process dedup Map
 *   B-3 heartbeat-vs-commit race        → HeartbeatController + stop-before-commit
 *   B-4 nested-serverTimestamp footgun  → saveProgress uses dot-notation
 *   B-5 catch-vs-finally lock window    → single atomic terminal write on failure
 *   B-6 null-as-failure infinite retry  → castAttempted/titleAttempted flags
 *   H-1 failureReason leak              → sanitizeFailureReason() whitelist
 *   H-3 clock-skew negative-age         → Math.max(0, ageMs)
 *   H-4 non-null-assertion silent fail  → validateStoryInput throws explicitly
 *   H-5 resumed flag off-by-one         → state.attempt >= 1 (was > 1)
 *   H-7 firestore_persist event removed → re-emitted around batch.commit
 *   H-9 char-name dot-escape            → FieldPath for map keys
 *   H-10 SIGTERM zombie locks           → handler best-effort marks in-flight failed
 *   L-2 32-bit WORKER_ID collisions     → full UUID
 *   M-7 per-call new Firestore()        → module-scope db
 */

import { Firestore, FieldValue, FieldPath, Timestamp } from '@google-cloud/firestore';
import { v4 as uuid } from 'uuid';
import {
  StoryDocument,
  StoryInput,
  GeneratedStory,
  GenerationPhase,
  PageGenerationRecord,
  ArtStyle,
  FailureCode,
} from '../types';
import { generateStory, generateAllIllustrations, generateModerationText, generateVisionModerationText, AllIllustrationsResult } from './gemini';
import { moderateStoryText } from './moderation';
import { moderateStoryImages, ModeratableImage } from './visionModeration';
import { downloadRef, isOurBucketUrl } from './gcsDownload';
import { JobState, JobStateWriter, progressMessage } from './jobState';
import { emitStageEvent, storyTag } from './instrumentation';

const HEARTBEAT_INTERVAL_MS = 15_000;
const LOCK_STALE_THRESHOLD_MS = 90_000;

// FC-025 L-2: full UUID instead of 8-char slice. Same module-scope binding
// (one identity per process; combined with the per-storyId dedup Map below
// this gives exactly-one-worker-per-story-per-process semantics).
// FC-030: exported so `fireWorkerInBackground`'s transactional catch can
// distinguish "another live worker owns the doc" (don't clobber) from
// "my own process's worker just failed to clean up" (recover by writing
// failed). The catch predicate is `workerId !== WORKER_ID`.
export const WORKER_ID = `${process.env.K_REVISION ?? 'local'}-${uuid()}`;

// FC-025 M-7: module-scope Firestore client. Previously instantiated inside
// runStoryWorker on every call, leaking gRPC connection pools under
// concurrency=4 — directly compounding the Phase 1 OOM hypothesis.
//
// ignoreUndefinedProperties: GeneratedStory pages carry optional fields
// (soundEffects/emphasizedWords) that gemini.ts normalizes to `undefined`
// when empty/absent. saveStoryText writes the raw story object, and Firestore
// rejects `undefined` values by default — which failed the whole worker. This
// drops undefined optional fields on write (the desired omit behavior).
const db = new Firestore({ ignoreUndefinedProperties: true });

// FC-025 B-1: in-process dedup. Same-process concurrent calls on the same
// storyId share one Promise — the second caller awaits the first's result
// rather than racing through claimLock and producing duplicate pages. Map
// is cleared in a finally so a failed run doesn't poison future calls.
const inFlightWorkers = new Map<string, Promise<RunStoryWorkerResult>>();

export class LockHeldError extends Error {
  constructor(public storyId: string, public heldBy: string) {
    super(`Story ${storyId} is locked by another live worker (${heldBy})`);
    this.name = 'LockHeldError';
  }
}

export class StoryNotResumableError extends Error {
  constructor(public storyId: string, public reason: string) {
    super(`Story ${storyId} cannot be resumed: ${reason}`);
    this.name = 'StoryNotResumableError';
  }
}

/**
 * FC-025 H-1: classify a thrown error into a bounded FailureCode the
 * client can safely render. The raw err.message (which may carry Gemini
 * SDK details — billing project IDs, model URLs, quota JSON, stack
 * frames) is logged server-side only, never persisted to Firestore.
 */
function sanitizeFailureReason(err: unknown): FailureCode {
  if (!err) return 'unknown';
  const s = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/safety|blocked|policy/.test(s)) return 'safety_blocked';
  if (/quota|rate.?limit/.test(s)) return 'quota_exceeded';
  if (/fetch failed|econnreset|etimedout|socket hang up|network/.test(s)) return 'network_error';
  if (/sigterm/.test(s)) return 'sigterm';
  // Anything from the Gemini stack that's a 4xx/5xx but doesn't match the
  // specific categories above falls through as generation_error.
  if (/gemini|generative|generation|model/.test(s)) return 'generation_error';
  return 'unknown';
}

/**
 * FC-025 H-4: explicit validation of doc fields the worker reads as
 * required StoryInput. Previously used non-null assertions (`!`), which
 * silently propagated undefined into Gemini prompts on a partially-
 * written doc, producing literal "undefined" in the story text.
 * Throws StoryNotResumableError so the route returns 410 Gone.
 */
function validateStoryInput(data: Partial<StoryDocument>, storyId: string): StoryInput {
  const required: Array<keyof StoryDocument> = ['childName', 'setting', 'moral', 'length', 'favoriteAnimal'];
  const missing = required.filter((k) => data[k] === undefined || data[k] === null);
  if (missing.length > 0) {
    throw new StoryNotResumableError(storyId, `doc missing required fields: ${missing.join(', ')}`);
  }
  return {
    childName: data.childName as string,
    childGender: data.childGender ?? undefined,
    favoriteAnimal: data.favoriteAnimal as string,
    specialFriendName: data.specialFriendName ?? undefined,
    specialFriendDescription: data.specialFriendDescription ?? undefined,
    setting: data.setting as string,
    moral: data.moral as string,
    authorStyle: data.authorStyle ?? undefined,
    writingStyle: data.writingStyle,
    length: data.length as 'short' | 'medium' | 'long',
    artStyle: data.artStyle ?? undefined,
  };
}

/**
 * Build an in-memory JobState from the persisted Firestore doc. Bytes maps
 * are always empty here — they're populated lazily by generateAllIllustrations.
 */
function loadJobState(data: Partial<StoryDocument>, storyId: string): JobState {
  return {
    storyId,
    // FC-025 H-5: keep doc's actual attempt count (no ?? 1 default — initial
    // doc writes 0). `resumed` is derived from state.attempt >= 1 below.
    attempt: data.attempt ?? 0,
    storyText: data.storyText,
    characterReferenceUrls: data.characterReferenceUrls ?? {},
    characterRefBytes: new Map(),
    castReferenceUrl: data.castReferenceUrl,
    castAttempted: data.castAttempted, // FC-025 B-6
    castRefBytes: undefined,
    titlePageImageUrl: data.titlePageImageUrl,
    titleAttempted: data.titleAttempted, // FC-025 B-6
    pageUrls: (data.pageUrls ?? {}) as Record<string, PageGenerationRecord>,
    anchorPageBytes: new Map(),
  };
}

/**
 * Firestore-backed JobStateWriter. Each method does a partial doc update via
 * dot-notation (FieldPath for keys that may contain dots, per FC-025 H-9)
 * so we don't overwrite siblings.
 */
class FirestoreJobStateWriter implements JobStateWriter {
  constructor(private storyRef: FirebaseFirestore.DocumentReference) {}

  async saveStoryText(story: GeneratedStory): Promise<void> {
    await this.storyRef.update({ storyText: story });
  }

  async saveCharacterReference(name: string, url: string): Promise<void> {
    // FC-025 H-9: FieldPath treats name as a literal key. Without this,
    // a character name containing '.' (e.g. "Mr. Whiskers") would be
    // parsed as a nested-map path: characterReferenceUrls.Mr.{" Whiskers": ...}
    await this.storyRef.update(new FieldPath('characterReferenceUrls', name), url);
  }

  async saveCastReference(url: string | null): Promise<void> {
    // FC-025 B-6: castAttempted=true is the load-bearing signal on resume —
    // distinguishes "tried and failed" (null URL + attempted) from
    // "never tried" (no URL + no attempted). Without this the failure was
    // retried every resume.
    await this.storyRef.update({ castReferenceUrl: url, castAttempted: true });
  }

  async saveTitlePage(url: string | null): Promise<void> {
    await this.storyRef.update({ titlePageImageUrl: url, titleAttempted: true });
  }

  async savePage(pageNumber: number, record: PageGenerationRecord): Promise<void> {
    // FieldPath here too for defensive consistency — page numbers don't
    // contain dots but the pattern is uniform with saveCharacterReference.
    await this.storyRef.update(new FieldPath('pageUrls', String(pageNumber)), record);
  }

  async saveProgress(phase: GenerationPhase, completedSteps: number, totalSteps: number, message: string): Promise<void> {
    // FC-025 B-4: dot-notation per key. Previously wrote a nested object
    // literal containing FieldValue.serverTimestamp() — the SDK does not
    // guarantee sentinel-value resolution inside nested object literals;
    // updatedAt could silently serialize as null. Per-key dot-notation
    // resolves sentinels reliably.
    await this.storyRef.update({
      'progress.phase': phase,
      'progress.completedSteps': completedSteps,
      'progress.totalSteps': totalSteps,
      'progress.message': message,
      'progress.updatedAt': FieldValue.serverTimestamp(),
    });
  }
}

/**
 * FC-025 B-3 + H-10: cancellable heartbeat. Self-scheduling setTimeout
 * with .unref() so it doesn't block process exit. stop() flips a flag
 * AND awaits any in-flight refresh, so a terminal batch.commit clearing
 * workerHeartbeatAt isn't race-resurrected by a late tick landing after.
 */
class HeartbeatController {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private storyRef: FirebaseFirestore.DocumentReference, private intervalMs: number) {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.inFlight = (async () => {
        try {
          await this.storyRef.update({ workerHeartbeatAt: FieldValue.serverTimestamp() });
        } catch (err) {
          console.warn(`[FC-017] heartbeat refresh failed:`, err);
        }
      })().finally(() => this.schedule());
    }, this.intervalMs);
    // FC-025 H-10: .unref() so the interval doesn't keep the Node event
    // loop alive past intended termination (SIGTERM during a deploy).
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}

/**
 * Transactionally claim the lock on a story. Throws LockHeldError if a live
 * worker holds it; returns the loaded doc data on success.
 *
 * FC-025 B-1: dropped the `data.workerId === WORKER_ID` self-skip. Without
 * it, same-process concurrent claims raced through both branches and both
 * proceeded. In-process dedup in runStoryWorker() ensures legitimate
 * same-process re-entry never reaches this function with a duplicate.
 *
 * FC-025 H-3: clock-skew guard via Math.max(0, ageMs).
 */
async function claimLock(
  storyRef: FirebaseFirestore.DocumentReference,
  storyId: string,
): Promise<Partial<StoryDocument>> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(storyRef);
    if (!snap.exists) throw new StoryNotResumableError(storyId, 'doc does not exist');
    const data = snap.data() as Partial<StoryDocument>;

    if (data.status === 'complete') {
      throw new StoryNotResumableError(storyId, 'already complete');
    }

    // Lock-held check (no self-skip). If anyone has the lock and the
    // heartbeat is fresh, throw. Negative ageMs (clock skew, worker behind
    // Firestore's server-timestamp) is clamped to 0 → treated as fresh.
    if (data.workerId) {
      const hb = data.workerHeartbeatAt as Timestamp | undefined;
      const ageMs = hb ? Math.max(0, Date.now() - hb.toMillis()) : Infinity;
      if (ageMs < LOCK_STALE_THRESHOLD_MS) {
        throw new LockHeldError(storyId, data.workerId);
      }
      console.warn(`${storyTag(storyId)} Lock held by ${data.workerId} but heartbeat stale (${Math.round(ageMs / 1000)}s ago) — taking over.`);
    }

    tx.update(storyRef, {
      workerId: WORKER_ID,
      workerHeartbeatAt: FieldValue.serverTimestamp(),
      status: 'generating',
      attempt: FieldValue.increment(1),
      failureReason: FieldValue.delete(),
    });

    return data;
  });
}

export interface RunStoryWorkerResult {
  story: GeneratedStory;
  illustrations: AllIllustrationsResult;
  elapsedMs: number;
}

/**
 * Main entry point. FC-025 B-1: in-process dedup before any Firestore work
 * — same-process concurrent calls on the same storyId share one Promise.
 * Mobile double-tap of Resume → both await the same result.
 */
export async function runStoryWorker(storyId: string): Promise<RunStoryWorkerResult> {
  const existing = inFlightWorkers.get(storyId);
  if (existing) {
    console.log(`${storyTag(storyId)} In-process worker already running; awaiting it.`);
    return existing;
  }
  const promise = runStoryWorkerImpl(storyId);
  inFlightWorkers.set(storyId, promise);
  try {
    return await promise;
  } finally {
    inFlightWorkers.delete(storyId);
  }
}

async function runStoryWorkerImpl(storyId: string): Promise<RunStoryWorkerResult> {
  const storyRef = db.collection('stories').doc(storyId);
  const startTime = Date.now();

  // claimLock can throw LockHeldError / StoryNotResumableError / transient
  // Firestore errors. The route catches them; we emit a total-failure
  // stage_event from there for H-6 observability (not from inside this
  // try block, since the lock isn't even held yet).
  const docData = await claimLock(storyRef, storyId);

  const heartbeat = new HeartbeatController(storyRef, HEARTBEAT_INTERVAL_MS);

  try {
    const state = loadJobState(docData, storyId);
    const writer = new FirestoreJobStateWriter(storyRef);

    // FC-025 H-4: explicit validation, not non-null assertions.
    const input = validateStoryInput(docData, storyId);
    const favoriteAnimal = input.favoriteAnimal!;
    const artStyle: ArtStyle = input.artStyle ?? 'watercolor';

    // ----- Phase 1: story text -----
    let story: GeneratedStory;
    if (state.storyText) {
      console.log(`${storyTag(storyId)} Resume: story text already persisted — skipping story-text phase.`);
      story = state.storyText;
    } else {
      await writer.saveProgress('story-text', 0, 1, progressMessage('story-text', 0, 1));
      story = await generateStory(input, storyId);
      // FC-037 layer 3: fail-closed output moderation gate. Runs BEFORE
      // saveStoryText, so any persisted storyText has passed the gate and the
      // resume path (which skips this phase when state.storyText is present)
      // never needs to re-moderate. A block throws a ModerationBlockedError
      // whose message contains "safety blocked" → sanitizeFailureReason maps
      // it to FailureCode 'safety_blocked' (reuses the mobile safety UX).
      await moderateStoryText(story, (prompt) => generateModerationText(prompt, storyId), { storyId });
      await writer.saveStoryText(story);
      await writer.saveProgress('story-text', 1, 1, progressMessage('story-text', 1, 1));
    }

    // ----- Phases 2-5: illustrations (resume-aware via state + writer) -----
    const illustrations = await generateAllIllustrations(
      story,
      storyId,
      favoriteAnimal,
      artStyle,
      input.childName,
      { state, writer },
    );

    // ----- FC-041: vision moderation gate -----
    // All page URLs are known but the doc is NOT yet 'complete' (the finalize
    // batch below is what sets status:'complete' + writes the pages
    // subcollection). Re-download the CHILD-FACING images (title + each page)
    // from GCS and classify each; ANY unsafe / malformed / timeout / errored
    // verdict on ANY image throws a ModerationBlockedError → unwinds into the
    // catch below → sanitizeFailureReason maps "safety blocked" to
    // FailureCode 'safety_blocked' (reuses the existing safety UX; no new
    // FailureCode; no 'complete' doc and no pages subcollection for a blocked
    // story, because the gate runs BEFORE the finalize batch).
    //
    // Runs on EVERY terminal run (initial or resume) — image URLs live on the
    // doc across a resume and generateAllIllustrations rehydrates/reuses them,
    // so re-moderating the final image set before 'complete' is the safe
    // invariant (no "already moderated" flag; the images are the source of
    // truth). Cost: N+1 vision calls per story (each page + title); sequential
    // with first-block short-circuit; 30s per-call timeout.
    const candidateUrls: Array<{ url: string; label: string }> = [
      ...(illustrations.titlePageImageUrl ? [{ url: illustrations.titlePageImageUrl, label: 'title' }] : []),
      ...illustrations.pageUrls.map((url, i) => ({ url, label: `page-${i + 1}` })),
    ];
    const imagesToModerate: ModeratableImage[] = [];
    for (const { url, label } of candidateUrls) {
      // FC-041 review HIGH: downloadRef returns null for TWO different cases;
      // they must NOT be treated identically or an unsafe child-facing image
      // could reach 'complete' unmoderated when its download flakes:
      //   (a) a NON-bucket URL (placehold.co placeholder from a failed image
      //       GENERATION) — benign, correctly SKIPPED. A static placeholder is
      //       safe and moderating a non-bucket URL is impossible.
      //   (b) an OUR-bucket URL whose download THREW (transient 5xx / throttle /
      //       network blip — caught in gcsDownload.ts and returned null). This
      //       is a real child-facing image we simply couldn't read. Skipping it
      //       would fail OPEN. FAIL CLOSED instead: throw so the story does NOT
      //       reach 'complete'.
      // Categorization: a download failure is an INFRA failure, NOT a
      // content-safety failure — throw a PLAIN Error (message deliberately free
      // of safety/blocked/policy) so sanitizeFailureReason maps it to the
      // default 'generation_error' (RESUMABLE; FC-031's 3-attempt budget caps
      // any loop on a permanently-unreadable object). ModerationBlockedError is
      // reserved strictly for actual unsafe classifier verdicts.
      const bytes = await downloadRef(url);
      if (bytes) {
        imagesToModerate.push({ data: bytes.data, mimeType: bytes.mimeType, label });
      } else if (isOurBucketUrl(url)) {
        // (b) our-bucket image that failed to download — fail closed as infra.
        // The message deliberately AVOIDS safety/blocked/policy (so it does NOT
        // map to safety_blocked) and INCLUDES "generation" so
        // sanitizeFailureReason maps it to the RESUMABLE 'generation_error'
        // (the /gemini|generative|generation|model/ branch), matching FC-031's
        // retry-budget behavior for transient infra failures.
        throw new Error(
          `Vision moderation: could not re-download page image for classification during generation (${label}); failing closed pending retry`,
        );
      }
      // else: (a) non-bucket placeholder — skip.
    }
    await moderateStoryImages(
      imagesToModerate,
      (prompt, image) => generateVisionModerationText(prompt, image, storyId),
      { storyId },
    );

    // ----- Phase 6: finalize -----
    // FC-025 B-3: stop heartbeat BEFORE the terminal batch.commit so a late
    // tick can't resurrect workerHeartbeatAt after the batch deletes it.
    await heartbeat.stop();
    await writer.saveProgress('finalizing', 0, 1, progressMessage('finalizing', 0, 1));

    const firestoreStart = Date.now();
    const batch = db.batch();
    story.pages.forEach((page, index) => {
      // FC-030 Change 1 — deterministic page-doc IDs. Was auto-id'd:
      // any double-execution path (sweep ↔ takeover race, SIGTERM during
      // this batch.commit, fire-and-forget bg-catch clobbering a healthy
      // worker) produced TWO N-page sets in the subcollection, and the
      // mobile reader (orders by pageNumber) rendered each page twice.
      // With deterministic IDs scoped to (storyId, pageNumber), a second
      // successful batch in a different lifetime writes the same docs
      // with identical content — last-write-wins is benign. The reader
      // queries by .orderBy('pageNumber'), so doc IDs don't matter to it.
      // Existing complete stories (auto-id'd) are untouched.
      const pageRef = storyRef.collection('pages').doc(String(page.pageNumber));
      batch.set(pageRef, {
        pageNumber: page.pageNumber,
        text: page.text,
        sceneDescription: page.sceneDescription,
        imageUrl: illustrations.pageUrls[index],
        ...(page.soundEffects && page.soundEffects.length > 0 ? { soundEffects: page.soundEffects } : {}),
        ...(page.emphasizedWords && page.emphasizedWords.length > 0 ? { emphasizedWords: page.emphasizedWords } : {}),
      });
    });
    batch.update(storyRef, {
      title: story.title,
      status: 'complete',
      pageCount: story.pages.length,
      characterReferenceUrls: illustrations.characterReferenceUrls,
      ...(story.characterSheets && story.characterSheets.length > 0
        ? { characterSheets: story.characterSheets }
        : {}),
      ...(story.settingIdentity && story.settingIdentity.name
        ? { settingIdentity: story.settingIdentity }
        : {}),
      ...(story.titlePage ? { titlePage: story.titlePage } : {}),
      ...(illustrations.titlePageImageUrl ? { titlePageImageUrl: illustrations.titlePageImageUrl } : {}),
      ...(illustrations.castReferenceUrl ? { castReferenceUrl: illustrations.castReferenceUrl } : {}),
      workerId: FieldValue.delete(),
      workerHeartbeatAt: FieldValue.delete(),
      progress: FieldValue.delete(),
      storyText: FieldValue.delete(),
      pageUrls: FieldValue.delete(),
      castAttempted: FieldValue.delete(), // FC-025 B-6: resume payload cleanup
      titleAttempted: FieldValue.delete(),
    });
    await batch.commit();
    // FC-025 H-7: restore the firestore_persist stage_event that was
    // present in the pre-Phase-2 route handler. FC-016 dashboards depend
    // on this signal.
    emitStageEvent({
      storyId, stage: 'firestore_persist', latencyMs: Date.now() - firestoreStart,
      pageCount: story.pages.length, outcome: 'success',
    });

    const elapsed = Date.now() - startTime;
    console.log(`${storyTag(storyId)} Story completed in ${elapsed}ms`);
    emitStageEvent({
      storyId, stage: 'total', latencyMs: elapsed,
      pageCount: story.pages.length, outcome: 'success',
      // FC-025 H-5: state.attempt is the doc's PRE-increment value (claimLock
      // bumps it to state.attempt+1). resumed: state.attempt >= 1 means
      // "this is at least the 2nd run on this doc".
      detail: { resumed: state.attempt >= 1, attempt: state.attempt + 1 },
    });

    return { story, illustrations, elapsedMs: elapsed };
  } catch (err) {
    // FC-025 B-5: single atomic update — status + sanitized failureReason +
    // lock-clear in one shot. Previously the catch wrote status='failed'
    // separately from the finally's lock-clear; if Firestore was momentarily
    // unavailable between them, the doc stayed status='failed' with workerId
    // still set, and the next /resume saw a stale-but-not-yet-expired lock
    // → 409 for up to 90s. Now they land together or not at all.
    await heartbeat.stop();
    const rawMessage = err instanceof Error ? err.message : String(err);
    const failureCode = sanitizeFailureReason(err);
    console.error(`${storyTag(storyId)} Worker failed (sanitized=${failureCode}):`, err);
    try {
      await storyRef.update({
        status: 'failed',
        failureReason: failureCode,
        workerId: FieldValue.delete(),
        workerHeartbeatAt: FieldValue.delete(),
      });
    } catch (writeErr) {
      console.error(`${storyTag(storyId)} Failed to write terminal failure state:`, writeErr);
    }
    emitStageEvent({
      storyId, stage: 'total', latencyMs: Date.now() - startTime,
      outcome: 'failure',
      detail: { failureCode, rawMessage },
    });
    throw err;
  } finally {
    // FC-025 B-3 + B-5: heartbeat is already stopped on success (before
    // batch.commit) AND on failure (top of catch). This is belt-and-suspenders
    // for any control-flow path that bypassed both — and a transactional
    // lock-release only if THIS worker still holds the lock (so a stale-
    // takeover by another worker isn't clobbered).
    await heartbeat.stop();
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(storyRef);
        const data = snap.data() as Partial<StoryDocument> | undefined;
        if (data?.workerId === WORKER_ID) {
          tx.update(storyRef, {
            workerId: FieldValue.delete(),
            workerHeartbeatAt: FieldValue.delete(),
          });
        }
      });
    } catch (releaseErr) {
      console.warn(`${storyTag(storyId)} Conditional lock-release in finally failed:`, releaseErr);
    }
  }
}

/**
 * FC-025 H-10 + FC-030 Change 3: SIGTERM handler. Cloud Run sends SIGTERM
 * ~10s before SIGKILL on scale-down. Best-effort: mark every in-flight
 * story as failed:sigterm so the next /resume isn't blocked by a stale-
 * but-fresh lock for up to 90s.
 *
 * FC-030 Change 3 — uses a transaction that refuses to overwrite a
 * terminal status. The previous blind `update` raced with the
 * success-path `batch.commit`: if SIGTERM fired during the ~100-500ms
 * batch.commit window, the SIGTERM handler's separate single-field
 * update could land AFTER batch.commit, clobbering status='complete'
 * with status='failed:sigterm'. The transaction's re-read closes that
 * window. Combined with FC-030 Change 1 (deterministic page IDs), even
 * if a race somehow sneaks through, resume is idempotent — no
 * duplicate-pages corruption.
 *
 * Doesn't await Promise.all — runs in parallel with a 5s deadline.
 * Heartbeats already .unref()'d so the process can exit.
 */
/**
 * FC-030 — extracted SIGTERM transaction body so tests can exercise the
 * production code path against a Firestore double instead of an inline
 * copy. Pure-ish: takes a (db, storyId) and returns a Promise that
 * either writes the failed:sigterm marker OR aborts (no-op) when the
 * doc is already terminal.
 *
 * Predicate: status not in {complete, failed} → write failed:sigterm.
 * The complete/failed guard prevents:
 *   - Clobbering a `complete` written by an in-flight success-path
 *     batch.commit landing concurrently with SIGTERM (~100-500ms window).
 *   - Clobbering a `failed` written by the worker's own catch with a
 *     more-specific failureReason (generation_error/quota_exceeded/etc).
 */
export async function sigtermMarkFailed(
  db: Firestore,
  storyId: string,
): Promise<'wrote' | 'skipped-terminal' | 'skipped-missing'> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection('stories').doc(storyId);
    const snap = await tx.get(ref);
    if (!snap.exists) return 'skipped-missing' as const;
    const data = snap.data() as Partial<StoryDocument>;
    if (data.status === 'complete' || data.status === 'failed') {
      return 'skipped-terminal' as const;
    }
    tx.update(ref, {
      status: 'failed',
      failureReason: 'sigterm' as FailureCode,
      workerId: FieldValue.delete(),
      workerHeartbeatAt: FieldValue.delete(),
    });
    return 'wrote' as const;
  });
}

function installSigtermHandler(): void {
  let handled = false;
  process.on('SIGTERM', () => {
    if (handled) return;
    handled = true;
    const ids = [...inFlightWorkers.keys()];
    if (ids.length === 0) return;
    console.warn(`[FC-017] SIGTERM received; marking ${ids.length} in-flight story/stories as failed:sigterm`);
    const writes = ids.map((id) =>
      sigtermMarkFailed(db, id).catch((e) => {
        console.warn(`[FC-017] SIGTERM cleanup failed for ${id}:`, e);
      }),
    );
    // Don't await — Cloud Run grace is ~10s and we can't block the
    // process. These writes are best-effort.
    Promise.race([
      Promise.allSettled(writes),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).catch(() => { /* swallow */ });
  });
}

// Register once at module load.
installSigtermHandler();
