import { Router, Response } from 'express';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { WRITING_STYLE_IDS } from '../prompts/story';
import { runStoryWorker, LockHeldError, StoryNotResumableError } from '../services/worker';
import { storyTag, emitStageEvent } from '../services/instrumentation';
import {
  AuthRequest,
  StoryInput,
  ArtStyle,
  StoryDocument,
} from '../types';

/**
 * FC-025 H-2: explicit allowlist of fields safe to surface to the client
 * for a story doc. The Phase 2 schema added several internal fields
 * (workerId, workerHeartbeatAt, storyText, pageUrls, attempt) that must
 * NEVER reach the client — they leak Cloud Run revision names, duplicate
 * payloads, and resume internals. The pre-Phase-2 GET /:id spread the
 * whole doc; this allowlist replaces that.
 */
const CLIENT_VISIBLE_DOC_FIELDS = [
  'userId', 'title', 'childName', 'childGender', 'favoriteAnimal',
  'specialFriendName', 'specialFriendDescription', 'setting', 'moral',
  'authorStyle', 'writingStyle', 'length', 'artStyle', 'status', 'pageCount',
  'characterReferenceUrls', 'characterSheets', 'settingIdentity', 'titlePage',
  'titlePageImageUrl', 'castReferenceUrl', 'progress', 'failureReason',
] as const;

function pickClientFields(data: FirebaseFirestore.DocumentData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CLIENT_VISIBLE_DOC_FIELDS) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

const router = Router();
const db = new Firestore();

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * FC-017 Phase 3 helper: fire the worker in the background without awaiting.
 * The route returns 202 immediately; the worker writes its own terminal
 * status (`complete` or `failed`) to the Firestore doc, which mobile observes
 * via onSnapshot. Pre-claim failures (LockHeldError, StoryNotResumableError)
 * thrown synchronously inside `runStoryWorker` before its try block can't be
 * caught by the worker — emit their `total` stage_event here. Internal worker
 * errors are already emitted by worker.ts itself; don't double-emit.
 *
 * Requires Cloud Run `--no-cpu-throttling` so the worker keeps running after
 * `res.send()`. Verified at `gcloud run services describe storybook-api`
 * before this PR shipped; revision storybook-api-00119-h6d+ have it set.
 */
function fireWorkerInBackground(storyId: string): void {
  runStoryWorker(storyId).catch((err) => {
    console.error(`${storyTag(storyId)} Background worker rejected:`, err);
    if (err instanceof LockHeldError) {
      emitStageEvent({ storyId, stage: 'total', latencyMs: 0, outcome: 'failure', detail: { errorType: 'LockHeldError' } });
    } else if (err instanceof StoryNotResumableError) {
      emitStageEvent({ storyId, stage: 'total', latencyMs: 0, outcome: 'failure', detail: { errorType: 'StoryNotResumableError', reason: err.reason } });
    }
    // Internal worker errors (everything inside its try block) already emitted
    // a `total` failure stage_event from the worker's catch + wrote
    // status='failed' + failureReason to the doc. The mobile snapshot
    // subscription will see that.
  });
}

/**
 * POST /api/stories/generate
 * FC-017 Phase 3: returns 202 with `{ storyId, status: 'queued' }` immediately
 * after the initial-doc write; mobile subscribes to the doc via onSnapshot
 * for live progress + terminal status. The worker runs in the background.
 */
router.post('/generate', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.uid;
  const input: StoryInput = req.body;
  const artStyle: ArtStyle = req.body.artStyle || 'watercolor';

  // Validate required fields
  const requiredFields = ['childName', 'setting', 'moral', 'length'];
  const missingFields = requiredFields.filter((field) => !req.body[field]);

  // Accept either specialFriendName+Description or legacy favoriteAnimal
  if (!req.body.specialFriendName && !req.body.favoriteAnimal) {
    missingFields.push('specialFriendName or favoriteAnimal');
  }
  if (req.body.specialFriendName && !req.body.specialFriendDescription) {
    missingFields.push('specialFriendDescription');
  }

  if (missingFields.length > 0) {
    res.status(400).json({
      error: 'Missing required fields',
      missingFields,
    });
    return;
  }

  // Validate length
  if (!['short', 'medium', 'long'].includes(input.length)) {
    res.status(400).json({
      error: 'Invalid length. Must be: short, medium, or long',
    });
    return;
  }

  // Validate art style
  if (!['watercolor', 'cartoon', 'storybook-classic', 'claymation', 'studio-ghibli', 'pixar-3d'].includes(artStyle)) {
    res.status(400).json({
      error: 'Invalid artStyle. Must be: watercolor, cartoon, storybook-classic, claymation, studio-ghibli, or pixar-3d',
    });
    return;
  }

  // Validate writing style (FC-014) — optional; absence falls back to authorStyle then default
  // WRITING_STYLE_IDS imported from prompts/story.ts is the single source of truth — adding a
  // new id there auto-extends this validator without a separate edit (review fix H3).
  if (
    input.writingStyle !== undefined &&
    !(WRITING_STYLE_IDS as readonly string[]).includes(input.writingStyle)
  ) {
    res.status(400).json({
      error: `Invalid writingStyle. Must be: ${WRITING_STYLE_IDS.join(', ')}`,
    });
    return;
  }

  const storyId = uuid();
  try {
    const storyRef = db.collection('stories').doc(storyId);
    console.log(`${storyTag(storyId)} POST /generate accepted for user ${userId}`);

    // Compute favoriteAnimal from specialFriend fields or use legacy value
    const favoriteAnimal = input.specialFriendName
      ? `${input.specialFriendDescription} named ${input.specialFriendName}`
      : input.favoriteAnimal || '';

    // FC-017 Phase 3: write the initial doc with status='queued' + all inputs,
    // then fire the worker in the background. Respond 202 with just the
    // storyId so mobile can subscribe to the Firestore doc immediately. The
    // worker handles claim, pipeline, persistence, and terminal status.
    await storyRef.set({
      userId,
      status: 'queued',
      childName: input.childName,
      childGender: input.childGender || null,
      favoriteAnimal,
      specialFriendName: input.specialFriendName || null,
      specialFriendDescription: input.specialFriendDescription || null,
      setting: input.setting,
      moral: input.moral,
      authorStyle: input.authorStyle || null,
      writingStyle: input.writingStyle || null,
      length: input.length,
      artStyle,
      attempt: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    fireWorkerInBackground(storyId);
    res.status(202).json({ storyId, status: 'queued' });
  } catch (error) {
    // Only pre-worker errors land here (the initial storyRef.set failed).
    // The worker is fire-and-forget; its own failures are written to the
    // Firestore doc as status='failed' and observed by mobile via snapshot.
    console.error(`${storyTag(storyId)} Initial doc write failed:`, error);
    emitStageEvent({
      storyId, stage: 'total', latencyMs: 0, outcome: 'failure',
      detail: { errorType: 'PreWorkerError', message: error instanceof Error ? error.message : String(error) },
    });
    res.status(500).json({
      error: 'Failed to start generation',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/stories/:id/resume
 *
 * FC-017 Phase 2 + Phase 3: re-fire the worker against an existing story doc
 * whose prior run died mid-flight or was marked failed. Returns 202 with
 * `{ storyId, status: 'queued' }` immediately; mobile subscribes to the
 * Firestore doc for terminal status (`complete` after the resume finishes,
 * `failed` if the resume also fails). Lock contention is no longer a
 * synchronous 409 — the worker's transactional claim rejects the call inside
 * the background, and the mobile snapshot subscription sees no progress
 * advance (or a new failureReason). Auth + ownership ARE still synchronous.
 */
router.post('/:id/resume', async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const userId = req.user!.uid;

  try {
    const storyDoc = await db.collection('stories').doc(id).get();
    if (!storyDoc.exists) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    const data = storyDoc.data() as Partial<StoryDocument>;
    if (data.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (data.status === 'complete') {
      res.status(410).json({ error: 'Story already complete' });
      return;
    }

    console.log(`${storyTag(id)} POST /:id/resume accepted by user ${userId} (current status: ${data.status})`);
    fireWorkerInBackground(id);
    res.status(202).json({ storyId: id, status: 'queued' });
  } catch (error) {
    console.error(`${storyTag(id)} Resume pre-worker failure:`, error);
    emitStageEvent({
      storyId: id, stage: 'total', latencyMs: 0, outcome: 'failure',
      detail: { errorType: 'PreWorkerError', message: error instanceof Error ? error.message : String(error) },
    });
    res.status(500).json({
      error: 'Resume failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/stories
 *
 * FC-017 Phase 4: returns ALL story statuses for the authenticated user
 * (was filtered to `status === 'complete'`). The mobile library now needs
 * to render `queued` / `generating` / `failed` rows with their own
 * affordances (progress chip on generating; Resume button on failed).
 * Returned via the same H-2 allowlist so worker internals don't leak.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.uid;

  try {
    const snapshot = await db
      .collection('stories')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    const stories = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...pickClientFields(doc.data()),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ stories });
  } catch (error) {
    console.error('Failed to fetch stories:', error);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

/**
 * GET /api/stories/:id
 * Get a single story with all pages
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const userId = req.user!.uid;

  try {
    const storyDoc = await db.collection('stories').doc(id).get();

    if (!storyDoc.exists) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    const storyData = storyDoc.data();

    // Ensure user owns this story
    if (storyData?.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Fetch all pages
    const pagesSnapshot = await storyDoc.ref
      .collection('pages')
      .orderBy('pageNumber')
      .get();

    const pages = pagesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // FC-025 H-2: explicit allowlist; never spread the raw doc.
    res.json({
      id: storyDoc.id,
      ...pickClientFields(storyData ?? {}),
      createdAt: storyData?.createdAt?.toDate?.()?.toISOString() || null,
      pages,
    });
  } catch (error) {
    console.error('Failed to fetch story:', error);
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

/**
 * DELETE /api/stories/:id
 * Delete a story and all its pages
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const userId = req.user!.uid;

  try {
    const storyRef = db.collection('stories').doc(id);
    const storyDoc = await storyRef.get();

    if (!storyDoc.exists) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    // Ensure user owns this story
    if (storyDoc.data()?.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Delete all pages first
    const pagesSnapshot = await storyRef.collection('pages').get();
    const batch = db.batch();

    pagesSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    // Delete the story document
    batch.delete(storyRef);

    await batch.commit();

    res.json({ success: true, message: 'Story deleted' });
  } catch (error) {
    console.error('Failed to delete story:', error);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

export default router;
