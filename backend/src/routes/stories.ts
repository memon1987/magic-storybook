import { Router, Response } from 'express';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { WRITING_STYLE_IDS } from '../prompts/story';
import { runStoryWorker, LockHeldError, StoryNotResumableError } from '../services/worker';
import { storyTag } from '../services/instrumentation';
import {
  AuthRequest,
  StoryInput,
  ArtStyle,
  StoryDocument,
} from '../types';

const router = Router();
const db = new Firestore();

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * POST /api/stories/generate
 * Generate a new story with illustrations
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
    console.log(`${storyTag(storyId)} Starting story generation for user ${userId}`);

    // Compute favoriteAnimal from specialFriend fields or use legacy value
    const favoriteAnimal = input.specialFriendName
      ? `${input.specialFriendDescription} named ${input.specialFriendName}`
      : input.favoriteAnimal || '';

    // FC-017 Phase 2: write the initial doc with status='queued' + all inputs,
    // then delegate to runStoryWorker which handles the lock claim, the
    // generation pipeline with per-phase Firestore writes, and the terminal
    // status update. Same synchronous contract as before — Phase 3 will make
    // this 202-ACK + background.
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

    const { story, illustrations, elapsedMs } = await runStoryWorker(storyId);

    // Return complete story
    res.json({
      id: storyId,
      title: story.title,
      childName: input.childName,
      childGender: input.childGender || null,
      favoriteAnimal,
      specialFriendName: input.specialFriendName || null,
      specialFriendDescription: input.specialFriendDescription || null,
      setting: input.setting,
      moral: input.moral,
      authorStyle: input.authorStyle || null,
      writingStyle: input.writingStyle || null,
      artStyle,
      pageCount: story.pages.length,
      characterReferenceUrls: illustrations.characterReferenceUrls,
      titlePage: story.titlePage || null,
      titlePageImageUrl: illustrations.titlePageImageUrl || null,
      pages: story.pages.map((page, index) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        imageUrl: illustrations.pageUrls[index],
        soundEffects: page.soundEffects ?? null,
        emphasizedWords: page.emphasizedWords ?? null,
      })),
      generationTimeMs: elapsedMs,
    });
  } catch (error) {
    console.error(`${storyTag(storyId)} Story generation failed:`, error);
    res.status(500).json({
      error: 'Story generation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/stories/:id/resume
 *
 * FC-017 Phase 2: re-fire the worker against an existing story doc whose
 * prior run died mid-flight or was marked failed. Auth + ownership are
 * enforced via the existing middleware + a userId check. Lock contention
 * (LockHeldError) → 409. Terminal-state issues (StoryNotResumableError) → 410.
 * Resumes use whatever artifacts the prior run persisted to Firestore and
 * skip them — only missing artifacts get regenerated. See docs/plans/fc-017.md.
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

    console.log(`${storyTag(id)} Resume requested by user ${userId} (current status: ${data.status})`);
    const { story, illustrations, elapsedMs } = await runStoryWorker(id);

    res.json({
      id,
      title: story.title,
      childName: data.childName,
      childGender: data.childGender ?? null,
      favoriteAnimal: data.favoriteAnimal,
      specialFriendName: data.specialFriendName ?? null,
      specialFriendDescription: data.specialFriendDescription ?? null,
      setting: data.setting,
      moral: data.moral,
      authorStyle: data.authorStyle ?? null,
      writingStyle: data.writingStyle ?? null,
      artStyle: data.artStyle,
      pageCount: story.pages.length,
      characterReferenceUrls: illustrations.characterReferenceUrls,
      titlePage: story.titlePage || null,
      titlePageImageUrl: illustrations.titlePageImageUrl || null,
      pages: story.pages.map((page, index) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        imageUrl: illustrations.pageUrls[index],
        soundEffects: page.soundEffects ?? null,
        emphasizedWords: page.emphasizedWords ?? null,
      })),
      generationTimeMs: elapsedMs,
      resumed: true,
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      console.warn(`${storyTag(id)} Resume conflict: ${error.message}`);
      res.status(409).json({ error: 'Story is already being generated', message: error.message });
      return;
    }
    if (error instanceof StoryNotResumableError) {
      console.warn(`${storyTag(id)} Resume rejected: ${error.message}`);
      res.status(410).json({ error: 'Story cannot be resumed', message: error.message });
      return;
    }
    console.error(`${storyTag(id)} Resume failed:`, error);
    res.status(500).json({
      error: 'Resume failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/stories
 * List all stories for the authenticated user
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.uid;

  try {
    const snapshot = await db
      .collection('stories')
      .where('userId', '==', userId)
      .where('status', '==', 'complete')
      .orderBy('createdAt', 'desc')
      .get();

    const stories = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
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

    res.json({
      id: storyDoc.id,
      ...storyData,
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
