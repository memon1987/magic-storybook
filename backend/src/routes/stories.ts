import { Router, Response } from 'express';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { WRITING_STYLE_IDS } from '../prompts/story';
import {
  generateStory,
  generateAllIllustrations,
} from '../services/gemini';
import {
  AuthRequest,
  StoryInput,
  ArtStyle,
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

  try {
    const storyId = uuid();
    const storyRef = db.collection('stories').doc(storyId);

    console.log(`Starting story generation for user ${userId}, story ${storyId}`);
    const startTime = Date.now();

    // Compute favoriteAnimal from specialFriend fields or use legacy value
    const favoriteAnimal = input.specialFriendName
      ? `${input.specialFriendDescription} named ${input.specialFriendName}`
      : input.favoriteAnimal || '';

    // Create initial story record with 'generating' status
    await storyRef.set({
      userId,
      status: 'generating',
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
      createdAt: FieldValue.serverTimestamp(),
    });

    // Step 1: Generate story text with Gemini
    console.log('Step 1: Generating story text...');
    const storyInput: StoryInput = { ...input, favoriteAnimal };
    const story = await generateStory(storyInput);

    // Step 2: Generate all illustrations (FC-013: per-character refs upfront; FC-012: title page)
    console.log('Step 2: Generating illustrations...');
    const { pageUrls, characterReferenceUrls, titlePageImageUrl } = await generateAllIllustrations(
      story,
      storyId,
      favoriteAnimal,
      artStyle,
      input.childName,
    );

    // Step 3: Save pages to Firestore
    console.log('Step 3: Saving to Firestore...');
    const batch = db.batch();

    story.pages.forEach((page, index) => {
      const pageRef = storyRef.collection('pages').doc();
      // FC-015: persist new optional overlay fields when present so the reader
      // can render the Skia text layer. Conditional spreads keep absent fields
      // out of Firestore (rather than writing undefined, which Firestore rejects).
      batch.set(pageRef, {
        pageNumber: page.pageNumber,
        text: page.text,
        sceneDescription: page.sceneDescription,
        imageUrl: pageUrls[index],
        ...(page.textPosition ? { textPosition: page.textPosition } : {}),
        ...(page.soundEffects && page.soundEffects.length > 0 ? { soundEffects: page.soundEffects } : {}),
        ...(page.emphasizedWords && page.emphasizedWords.length > 0 ? { emphasizedWords: page.emphasizedWords } : {}),
      });
    });

    // Update story status to 'complete'
    batch.update(storyRef, {
      title: story.title,
      status: 'complete',
      pageCount: story.pages.length,
      characterReferenceUrls, // FC-013: persist character ref URLs (empty object when not used)
      ...(story.titlePage ? { titlePage: story.titlePage } : {}),                      // FC-012
      ...(titlePageImageUrl ? { titlePageImageUrl } : {}),                              // FC-012
    });

    await batch.commit();

    const elapsed = Date.now() - startTime;
    console.log(`Story ${storyId} completed in ${elapsed}ms`);

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
      characterReferenceUrls, // FC-013
      titlePage: story.titlePage || null,            // FC-012
      titlePageImageUrl: titlePageImageUrl || null,  // FC-012
      pages: story.pages.map((page, index) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        imageUrl: pageUrls[index],
        // FC-015: surface overlay metadata so the reader can render text on the
        // very first generation response (before re-fetching from Firestore).
        textPosition: page.textPosition ?? null,
        soundEffects: page.soundEffects ?? null,
        emphasizedWords: page.emphasizedWords ?? null,
      })),
      generationTimeMs: elapsed,
    });
  } catch (error) {
    console.error('Story generation failed:', error);

    res.status(500).json({
      error: 'Story generation failed',
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
