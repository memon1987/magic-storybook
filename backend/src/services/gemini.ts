import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { v4 as uuid } from 'uuid';
import {
  StoryInput,
  GeneratedStory,
  ArtStyle,
  CharacterVisualSheet,
  SettingVisualIdentity,
} from '../types';
import { buildStoryPrompt } from '../prompts/story';
import { buildIllustrationPrompt } from '../prompts/illustration';
import { buildCharacterReferencePrompt } from '../prompts/characterReference';

// Initialize Gemini client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

// Initialize Cloud Storage
const storage = new Storage();
const bucketName = process.env.STORAGE_BUCKET!;
const bucket = storage.bucket(bucketName);

// Model constants
// Text: gemini-3-flash-preview
// Images: gemini-3.1-flash-image-preview ("Nano Banana 2", launched 2026-02-26).
//   ~90% text accuracy (vs ~94% on gemini-3-pro-image-preview) in exchange for
//   4-6s per image (vs 24-35s) and ~50% lower cost ($0.067 vs $0.13 per 1K image).
//   User override of FC-002; full benchmark plan deferred.
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

// Retry configuration for handling 503 Service Unavailable errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000; // 2 seconds

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (503 Service Unavailable)
 */
function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const errorStr = String(error);
    return errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('high demand');
  }
  return false;
}

/**
 * Generate a story using Gemini Pro
 */
export async function generateStory(input: StoryInput): Promise<GeneratedStory> {
  const prompt = buildStoryPrompt(input);

  console.log('Generating story with Gemini Pro...');
  const startTime = Date.now();

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
      });
      break;
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Story text: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  if (!response) {
    throw lastError instanceof Error ? lastError : new Error('Story text generation failed');
  }

  const elapsed = Date.now() - startTime;
  console.log(`Story generated in ${elapsed}ms`);

  // Extract text from response
  let text = response.text || '';

  // Handle markdown code blocks if present
  const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    text = jsonMatch[1];
  }

  // Clean up the text
  text = text.trim();

  try {
    const story = JSON.parse(text) as GeneratedStory;

    // Validate the response structure
    if (!story.title || !Array.isArray(story.pages)) {
      throw new Error('Invalid story structure: missing title or pages');
    }

    // Validate each page
    story.pages.forEach((page, index) => {
      if (typeof page.pageNumber !== 'number') {
        page.pageNumber = index + 1;
      }
      if (!page.text || !page.sceneDescription) {
        throw new Error(`Invalid page ${index + 1}: missing text or sceneDescription`);
      }
    });

    // Validate character sheets (graceful fallback if missing)
    if (!Array.isArray(story.characterSheets)) {
      console.warn('Story generation did not include characterSheets, using empty array');
      story.characterSheets = [];
    }

    // Validate setting identity (graceful fallback if missing)
    if (!story.settingIdentity || typeof story.settingIdentity !== 'object') {
      console.warn('Story generation did not include settingIdentity, using empty default');
      story.settingIdentity = { name: '', description: '' };
    }

    // Sort pages by page number
    story.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    return story;
  } catch (error) {
    console.error('Failed to parse story JSON:', text.substring(0, 500));
    throw new Error(`Failed to parse story: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Result from illustration generation, includes raw image data for reference use
 */
interface IllustrationResult {
  publicUrl: string;
  imageBase64: string | null;
  mimeType: string;
}

/**
 * One reference image to attach to a multimodal generation request.
 * `name` is required for type='character' so the prompt can address it
 * by name; setting refs are unnamed (there is at most one per call).
 */
export interface ReferenceImage {
  type: 'character' | 'setting';
  name?: string;
  data: string;
  mimeType: string;
}

/**
 * Upload a generated image buffer to Cloud Storage and return the public URL.
 * Shared by generateIllustration and generateCharacterReference.
 */
async function uploadGeneratedImage(
  imageBase64: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  const buffer = Buffer.from(imageBase64, 'base64');
  const file = bucket.file(filename);
  await file.save(buffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
  console.log(`Uploaded image: ${publicUrl}`);
  return publicUrl;
}

/**
 * Build the multimodal `contents` array for a page-illustration call.
 * Each reference is preceded by a short text label naming what it is so
 * the model can correlate the prompt's mentions with the right image.
 */
function buildPageContents(
  references: ReferenceImage[],
  promptText: string,
): Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> {
  const contents: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];

  let charIdx = 0;
  for (const ref of references) {
    if (ref.type === 'character') {
      charIdx += 1;
      contents.push({
        text: `Character reference ${charIdx}: "${ref.name ?? 'unnamed'}" — this character must appear identically (same colors, clothing, proportions, distinguishing features) wherever they show up on the page below.`,
      });
    } else {
      contents.push({
        text: 'Setting reference (page 1 of this book): match this art style, color palette, and any environmental details that should remain consistent.',
      });
    }
    contents.push({ inlineData: { data: ref.data, mimeType: ref.mimeType } });
  }

  contents.push({ text: promptText });
  return contents;
}

export async function generateIllustration(
  sceneDescription: string,
  animalType: string,
  storyId: string,
  pageNumber: number,
  style: ArtStyle = 'watercolor',
  pageText?: string,
  characterSheets?: CharacterVisualSheet[],
  settingIdentity?: SettingVisualIdentity,
  references: ReferenceImage[] = [],
): Promise<IllustrationResult> {
  const characterRefNames = references
    .filter((r) => r.type === 'character')
    .map((r) => ({ name: r.name ?? 'unnamed' }));

  const promptText = buildIllustrationPrompt(
    sceneDescription,
    animalType,
    style,
    pageText,
    characterSheets,
    settingIdentity,
    characterRefNames,
  );

  const contents = buildPageContents(references, promptText);

  const refSummary =
    references.length === 0
      ? ''
      : ` (with ${references.filter((r) => r.type === 'character').length} character ref(s)${references.some((r) => r.type === 'setting') ? ' + setting ref' : ''})`;
  console.log(`Generating illustration for page ${pageNumber} with ${IMAGE_MODEL}${refSummary}...`);
  const startTime = Date.now();

  let lastError: unknown = null;

  // Retry loop for handling temporary 503 errors
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: { responseModalities: ['IMAGE'] },
      });

      const elapsed = Date.now() - startTime;
      console.log(`Illustration for page ${pageNumber} generated in ${elapsed}ms (attempt ${attempt})`);

      const candidates = response.candidates || [];
      if (candidates.length === 0) {
        throw new Error('No candidates in generation response');
      }

      const parts = candidates[0]?.content?.parts || [];
      let imageData: string | null = null;
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }

      if (!imageData) {
        throw new Error('No image data in generation response');
      }

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/page-${pageNumber}-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      return { publicUrl, imageBase64: imageData, mimeType };
    } catch (error) {
      lastError = error;

      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Page ${pageNumber}: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }

      console.error(`Failed to generate illustration for page ${pageNumber} after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`All ${MAX_RETRIES} attempts failed for page ${pageNumber}`);
  // Avoid "unused variable" lint when retries don't trigger logging of lastError
  void lastError;
  return { publicUrl: `https://placehold.co/800x600/png?text=Page+${pageNumber}`, imageBase64: null, mimeType: 'image/png' };
}

/**
 * FC-013: Generate a single character "model sheet" reference image used to
 * anchor character appearance across all subsequent page generations.
 *
 * Returns a placeholder URL on total failure (3 retries exhausted) so the
 * pipeline can still proceed without the visual ref — degraded but not broken.
 */
export interface CharacterReferenceResult {
  name: string;
  publicUrl: string;
  imageBase64: string | null;
  mimeType: string;
}

export async function generateCharacterReference(
  character: CharacterVisualSheet,
  storyId: string,
  style: ArtStyle = 'watercolor',
): Promise<CharacterReferenceResult> {
  const promptText = buildCharacterReferencePrompt(character.name, character.description, style);
  const contents: Array<{ text: string }> = [{ text: promptText }];

  console.log(`Generating character reference for "${character.name}" with ${IMAGE_MODEL}...`);
  const startTime = Date.now();
  const safeNameSlug = character.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: { responseModalities: ['IMAGE'] },
      });

      const elapsed = Date.now() - startTime;
      console.log(`Character reference "${character.name}" generated in ${elapsed}ms (attempt ${attempt})`);

      const parts = response.candidates?.[0]?.content?.parts || [];
      let imageData: string | null = null;
      let mimeType = 'image/png';
      for (const part of parts) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }
      if (!imageData) {
        throw new Error('No image data in character reference response');
      }

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/character-refs/${safeNameSlug}-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      return { name: character.name, publicUrl, imageBase64: imageData, mimeType };
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Character ref "${character.name}": 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`Failed to generate character reference for "${character.name}" after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`All ${MAX_RETRIES} attempts failed for character reference "${character.name}"`);
  void lastError;
  return {
    name: character.name,
    publicUrl: `https://placehold.co/800x600/png?text=${encodeURIComponent(character.name)}`,
    imageBase64: null,
    mimeType: 'image/png',
  };
}

/**
 * Result from generating all illustrations (FC-013).
 */
export interface AllIllustrationsResult {
  pageUrls: string[];
  characterReferenceUrls: Record<string, string>; // empty when characterSheets is empty
}

/**
 * Generate all illustrations for a story.
 *
 * FC-013 pipeline (when story has named characters):
 *   1. Generate one model-sheet reference image per character in parallel
 *   2. Generate page 1 with all character references attached
 *   3. Generate pages 2..N in parallel; each call gets all character refs +
 *      page 1's image as a setting reference
 *
 * Backwards-compatible legacy path (when story.characterSheets is empty):
 *   1. Generate page 1 alone
 *   2. Generate pages 2..N in parallel with page 1 as a single ref
 */
export async function generateAllIllustrations(
  story: GeneratedStory,
  storyId: string,
  animalType: string,
  style: ArtStyle = 'watercolor',
): Promise<AllIllustrationsResult> {
  const startTime = Date.now();
  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const [firstPage, ...remainingPages] = sortedPages;

  // ----- Step 1 (FC-013): generate character references in parallel -----
  const characterReferenceUrls: Record<string, string> = {};
  // Map of character name -> raw image bytes/mime, for use as multimodal refs in page calls.
  // Only populated for refs that succeeded with real image data (placeholder fallbacks are URL-only).
  const characterRefImages: ReferenceImage[] = [];

  if (story.characterSheets.length > 0) {
    console.log(
      `Step 2a (FC-013): generating ${story.characterSheets.length} character reference image(s) in parallel: ${story.characterSheets.map((c) => c.name).join(', ')}...`,
    );
    const refResults = await Promise.all(
      story.characterSheets.map((c) => generateCharacterReference(c, storyId, style)),
    );
    for (const result of refResults) {
      characterReferenceUrls[result.name] = result.publicUrl;
      if (result.imageBase64) {
        characterRefImages.push({
          type: 'character',
          name: result.name,
          data: result.imageBase64,
          mimeType: result.mimeType,
        });
      } else {
        console.warn(
          `Character reference for "${result.name}" failed to produce image data — page generations will skip its visual ref (text description still applies).`,
        );
      }
    }
  } else {
    console.log('Step 2a (FC-013): story has no named characters — skipping character reference stage');
  }

  // ----- Step 2: generate page 1 (with character refs if available) -----
  console.log(`Step 2b: generating page ${firstPage.pageNumber} (page 1)...`);
  const firstResult = await generateIllustration(
    firstPage.sceneDescription,
    animalType,
    storyId,
    firstPage.pageNumber,
    style,
    firstPage.text,
    story.characterSheets,
    story.settingIdentity,
    characterRefImages, // page 1 gets character refs but no setting ref (it IS the setting establishing shot)
  );

  const results: Map<number, string> = new Map();
  results.set(firstPage.pageNumber, firstResult.publicUrl);

  // ----- Step 3: generate pages 2..N in parallel with character refs + page 1 setting ref -----
  if (remainingPages.length > 0) {
    const settingRef: ReferenceImage | null = firstResult.imageBase64
      ? { type: 'setting', data: firstResult.imageBase64, mimeType: firstResult.mimeType }
      : null;

    const pageReferences: ReferenceImage[] = settingRef
      ? [...characterRefImages, settingRef]
      : [...characterRefImages];

    console.log(
      `Step 2c: generating pages ${remainingPages.map((p) => p.pageNumber).join(', ')} in parallel with ${pageReferences.length} multimodal reference(s)...`,
    );

    const remainingPromises = remainingPages.map((page) =>
      generateIllustration(
        page.sceneDescription,
        animalType,
        storyId,
        page.pageNumber,
        style,
        page.text,
        story.characterSheets,
        story.settingIdentity,
        pageReferences,
      ),
    );

    const remainingResults = await Promise.all(remainingPromises);
    remainingPages.forEach((page, index) => {
      results.set(page.pageNumber, remainingResults[index].publicUrl);
    });
  }

  const pageUrls = sortedPages.map((page) => results.get(page.pageNumber)!);

  const elapsed = Date.now() - startTime;
  console.log(
    `All ${story.pages.length} illustrations + ${Object.keys(characterReferenceUrls).length} character ref(s) generated in ${elapsed}ms`,
  );

  return { pageUrls, characterReferenceUrls };
}
