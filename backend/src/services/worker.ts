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
 *  - On terminal failure: writes `status: 'failed'` + failureReason + clears
 *    workerId. Re-throws so the route returns a 500.
 *  - Heartbeat: setInterval(15s) refreshing workerHeartbeatAt while running.
 *    Cleared in a finally block so a crash before status-write at least
 *    releases the lock to a future resume.
 */

import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import { v4 as uuid } from 'uuid';
import {
  StoryDocument,
  StoryInput,
  GeneratedStory,
  GenerationPhase,
  PageGenerationRecord,
  ArtStyle,
} from '../types';
import { generateStory, generateAllIllustrations, AllIllustrationsResult } from './gemini';
import {
  JobState,
  JobStateWriter,
  emptyJobState,
  progressMessage,
} from './jobState';
import { emitStageEvent, storyTag } from './instrumentation';

const HEARTBEAT_INTERVAL_MS = 15_000;
const LOCK_STALE_THRESHOLD_MS = 90_000;

// Worker identity. K_REVISION is the Cloud Run revision name; combined with a
// per-process UUID it's unique across instances + restarts.
const WORKER_ID = `${process.env.K_REVISION ?? 'local'}-${uuid().slice(0, 8)}`;

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
 * Build an in-memory JobState from the persisted Firestore doc. Bytes maps are
 * always empty here — they're populated lazily by generateAllIllustrations
 * (either by re-downloading from GCS or by capturing freshly-generated output).
 */
function loadJobState(data: Partial<StoryDocument>, storyId: string): JobState {
  return {
    storyId,
    attempt: data.attempt ?? 1,
    storyText: data.storyText,
    characterReferenceUrls: data.characterReferenceUrls ?? {},
    characterRefBytes: new Map(),
    castReferenceUrl: data.castReferenceUrl,
    castRefBytes: undefined,
    titlePageImageUrl: data.titlePageImageUrl,
    pageUrls: (data.pageUrls ?? {}) as Record<string, PageGenerationRecord>,
    anchorPageBytes: new Map(),
  };
}

/**
 * Firestore-backed JobStateWriter. Each method does a partial doc update via
 * dot-notation so we don't overwrite siblings. Idempotent: writing the same
 * artifact twice is a no-op at the persistence layer (last-write-wins on
 * identical values).
 */
class FirestoreJobStateWriter implements JobStateWriter {
  constructor(private storyRef: FirebaseFirestore.DocumentReference) {}

  async saveStoryText(story: GeneratedStory): Promise<void> {
    await this.storyRef.update({ storyText: story });
  }

  async saveCharacterReference(name: string, url: string): Promise<void> {
    await this.storyRef.update({ [`characterReferenceUrls.${name}`]: url });
  }

  async saveCastReference(url: string | null): Promise<void> {
    // null means generation attempted and failed — record the absence so a
    // resume doesn't keep retrying. Use FieldValue.delete if we want to
    // distinguish "skipped because not needed" from "tried and failed", but
    // for now a literal null is simpler and the route reads it the same way.
    await this.storyRef.update({ castReferenceUrl: url });
  }

  async saveTitlePage(url: string | null): Promise<void> {
    await this.storyRef.update({ titlePageImageUrl: url });
  }

  async savePage(pageNumber: number, record: PageGenerationRecord): Promise<void> {
    await this.storyRef.update({ [`pageUrls.${pageNumber}`]: record });
  }

  async saveProgress(phase: GenerationPhase, completedSteps: number, totalSteps: number, message: string): Promise<void> {
    await this.storyRef.update({
      progress: {
        phase,
        completedSteps,
        totalSteps,
        message,
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
  }
}

/**
 * Transactionally claim the lock on a story. Throws LockHeldError if a live
 * worker holds it; returns the loaded doc data on success.
 */
async function claimLock(
  db: Firestore,
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

    // Lock-held check.
    if (data.workerId && data.workerId !== WORKER_ID) {
      const hb = data.workerHeartbeatAt as Timestamp | undefined;
      const ageMs = hb ? Date.now() - hb.toMillis() : Infinity;
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

/** Refresh the heartbeat. Errors are swallowed (a missed beat is recoverable). */
async function refreshHeartbeat(storyRef: FirebaseFirestore.DocumentReference): Promise<void> {
  try {
    await storyRef.update({ workerHeartbeatAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.warn(`[FC-017] heartbeat refresh failed:`, err);
  }
}

export interface RunStoryWorkerResult {
  story: GeneratedStory;
  illustrations: AllIllustrationsResult;
  elapsedMs: number;
}

/**
 * Main entry point for both initial generation and resume. The doc must
 * already exist with userId + inputs populated by the caller. Throws on
 * lock contention or terminal failure; on success returns the assembled
 * story payload for the route to surface to the client.
 */
export async function runStoryWorker(storyId: string): Promise<RunStoryWorkerResult> {
  const db = new Firestore();
  const storyRef = db.collection('stories').doc(storyId);
  const startTime = Date.now();

  const docData = await claimLock(db, storyRef, storyId);

  const heartbeat = setInterval(() => { refreshHeartbeat(storyRef).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);

  try {
    const state = loadJobState(docData, storyId);
    const writer = new FirestoreJobStateWriter(storyRef);

    // Reconstruct the input the original POST had. The doc carries every
    // field needed to reproduce the StoryInput shape.
    const input: StoryInput = {
      childName: docData.childName!,
      childGender: docData.childGender,
      favoriteAnimal: docData.favoriteAnimal,
      specialFriendName: docData.specialFriendName,
      specialFriendDescription: docData.specialFriendDescription,
      setting: docData.setting!,
      moral: docData.moral!,
      authorStyle: docData.authorStyle,
      writingStyle: docData.writingStyle,
      length: docData.length!,
      artStyle: docData.artStyle as ArtStyle,
    };
    const favoriteAnimal = docData.favoriteAnimal!;
    const artStyle = (docData.artStyle as ArtStyle) ?? 'watercolor';

    // ----- Phase 1: story text -----
    let story: GeneratedStory;
    if (state.storyText) {
      console.log(`${storyTag(storyId)} Resume: story text already persisted — skipping story-text phase.`);
      story = state.storyText;
    } else {
      await writer.saveProgress('story-text', 0, 1, progressMessage('story-text', 0, 1));
      story = await generateStory(input, storyId);
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

    // ----- Phase 6: finalize -----
    await writer.saveProgress('finalizing', 0, 1, progressMessage('finalizing', 0, 1));
    const batch = db.batch();
    story.pages.forEach((page, index) => {
      const pageRef = storyRef.collection('pages').doc();
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
      storyText: FieldValue.delete(), // resume payload no longer needed once complete
      pageUrls: FieldValue.delete(),  // ditto
    });
    await batch.commit();

    const elapsed = Date.now() - startTime;
    emitStageEvent({
      storyId, stage: 'total', latencyMs: elapsed,
      pageCount: story.pages.length, outcome: 'success',
      detail: { resumed: state.attempt > 1, attempt: state.attempt + 1 },
    });

    return { story, illustrations, elapsedMs: elapsed };
  } catch (err) {
    // Terminal failure: mark the doc as failed + record the reason. Don't
    // re-throw the lock fields; the finally block clears them. The /resume
    // endpoint will let the user retry.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${storyTag(storyId)} Worker failed:`, err);
    try {
      await storyRef.update({
        status: 'failed',
        failureReason: message,
      });
    } catch (writeErr) {
      console.error(`${storyTag(storyId)} Also failed to write failure status:`, writeErr);
    }
    emitStageEvent({
      storyId, stage: 'total', latencyMs: Date.now() - startTime,
      outcome: 'failure',
      detail: { message },
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
    // Release the lock even on failure so a resume attempt isn't blocked by
    // a stale workerId. The status field already reflects 'complete' or
    // 'failed' from the try/catch branches above.
    try {
      await storyRef.update({
        workerId: FieldValue.delete(),
        workerHeartbeatAt: FieldValue.delete(),
      });
    } catch (releaseErr) {
      console.warn(`${storyTag(storyId)} Lock release in finally failed:`, releaseErr);
    }
  }
}
