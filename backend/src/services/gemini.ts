import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { v4 as uuid } from 'uuid';
import {
  StoryInput,
  GeneratedStory,
  ArtStyle,
  CharacterVisualSheet,
  SettingVisualIdentity,
  TitlePage,
  TextPosition,
  TEXT_POSITIONS,
} from '../types';
import { buildStoryPrompt } from '../prompts/story';
import { buildIllustrationPrompt } from '../prompts/illustration';
import { buildCharacterReferencePrompt } from '../prompts/characterReference';
import { buildTitlePagePrompt } from '../prompts/titlePage';

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
// FC-019: Pro Image model used by `generateIllustrationPro` for the spike.
// ~94-96% text accuracy with multi-line support; ~2× cost; Google's forward
// image lane (Imagen 4 is being deprecated June 2026 per Google docs).
const IMAGE_MODEL_PRO = 'gemini-3-pro-image-preview';

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
 * FC-013 review fix H1: retry backoff with jitter.
 *
 * Without jitter, parallel callers (e.g., 3 character refs racing) that all
 * hit a 503 in the same window sleep for the exact same duration and retry in
 * lockstep — a textbook thundering herd. Jitter spreads the retries across a
 * window so retries don't all hit Gemini simultaneously.
 *
 * Returns base * (0.5 .. 1.5) random multiplier on the same exponential
 * backoff schedule (2s, 4s, 8s).
 */
function jitteredBackoffMs(attempt: number): number {
  const base = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  return Math.round(base * (0.5 + Math.random()));
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
        const delayMs = jitteredBackoffMs(attempt);
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

      // FC-015: validate optional overlay fields with graceful fallback so a
      // single bad value doesn't abort the whole story.
      //
      // Review fix HIGH-1: default missing OR invalid textPosition to 'bottom'
      // (NOT undefined). Without this, if Gemini omits the "MUST" field on a
      // page (which happens occasionally under load), the FC-015 path produces
      // an image with NO baked text AND the mobile overlay renders nothing —
      // strictly worse than the pre-FC-015 baseline. A guaranteed default
      // means every page always has visible narration.
      if (page.textPosition === undefined || !TEXT_POSITIONS.includes(page.textPosition)) {
        if (page.textPosition !== undefined) {
          console.warn(`Page ${page.pageNumber}: invalid textPosition "${page.textPosition}", defaulting to "bottom"`);
        } else {
          console.warn(`Page ${page.pageNumber}: missing textPosition, defaulting to "bottom"`);
        }
        page.textPosition = 'bottom';
      }
      // Review fix MEDIUM-6: soundEffects are baked INTO the image as
      // stylized words. Long entries trigger Gemini's known accuracy fall-off
      // on long in-image text; >2 of them clutters the reserved-space
      // contract. Cap length to 2 (matches story prompt) and reject entries
      // longer than 12 chars (an "onomatopoeia" should be one word).
      if (page.soundEffects !== undefined) {
        if (!Array.isArray(page.soundEffects)) {
          page.soundEffects = undefined;
        } else {
          page.soundEffects = page.soundEffects
            .filter((w): w is string => typeof w === 'string' && w.trim().length > 0 && w.trim().length <= 12)
            .slice(0, 2);
          if (page.soundEffects.length === 0) page.soundEffects = undefined;
        }
      }
      if (page.emphasizedWords !== undefined) {
        if (!Array.isArray(page.emphasizedWords)) {
          page.emphasizedWords = undefined;
        } else {
          page.emphasizedWords = page.emphasizedWords
            .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
            .slice(0, 4);
          if (page.emphasizedWords.length === 0) page.emphasizedWords = undefined;
        }
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

    // FC-012: validate title page (graceful fallback — generateAllIllustrations
    // will skip cover generation if this stays undefined, but log so we know).
    if (!story.titlePage || !story.titlePage.text || !story.titlePage.sceneDescription) {
      if (story.titlePage !== undefined) {
        console.warn('Story generation produced incomplete titlePage, falling back to no cover');
      }
      story.titlePage = undefined;
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
 *
 * FC-019 consistency bakeoff: `prior_page` is a previously-rendered page of
 * THIS story passed as an in-scene character + style anchor for later pages
 * (a real rendered example, stronger than the abstract white-bg model sheet).
 * `pageNumber` labels which page it was so the prompt can reference it.
 */
export interface ReferenceImage {
  type: 'character' | 'setting' | 'prior_page';
  name?: string;
  pageNumber?: number;
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
    } else if (ref.type === 'prior_page') {
      // FC-019 consistency bakeoff: a real rendered page of THIS book. The
      // strongest possible anchor — an in-context example of the characters
      // and style, not an abstract model sheet.
      contents.push({
        text: `Previous page${ref.pageNumber ? ' ' + ref.pageNumber : ''} of THIS SAME book. CRITICAL: the characters on the new page must look EXACTLY like they do here — identical faces, body shapes, colors, clothing, and proportions. Match this art style, color palette, line quality, and lighting precisely so the book looks like one continuous work by a single illustrator.`,
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
  textPosition?: TextPosition,
  soundEffects?: string[],
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
    textPosition,
    soundEffects,
  );

  const contents = buildPageContents(references, promptText);

  // FC-013 review fix H3: log multimodal payload size so post-deploy we can
  // diagnose payload-too-large failures (Gemini documents a 20MB inline cap).
  const payloadBytes = JSON.stringify(contents).length;
  const refSummary =
    references.length === 0
      ? ''
      : ` (with ${references.filter((r) => r.type === 'character').length} character ref(s)${references.some((r) => r.type === 'setting') ? ' + setting ref' : ''})`;
  console.log(
    `Generating illustration for page ${pageNumber} with ${IMAGE_MODEL}${refSummary} [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
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
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`Page ${pageNumber}: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }

      console.error(`Failed to generate illustration for page ${pageNumber} after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`All ${MAX_RETRIES} attempts failed for page ${pageNumber}; last error:`, lastError);
  return { publicUrl: `https://placehold.co/800x600/png?text=Page+${pageNumber}`, imageBase64: null, mimeType: 'image/png' };
}

/**
 * FC-019 spike: bake narration text INTO the image (legacy pre-FC-015 path),
 * parameterized by model so the consistency bakeoff can compare Gemini 3 Pro
 * Image vs Gemini 3.1 Flash Image head-to-head with identical inputs.
 *
 * Forces the `pageText` branch of `buildIllustrationPrompt` (text baked in)
 * and OMITS `textPosition` / `soundEffects` (Skia-overlay-only). Character
 * references — including FC-019 `prior_page` in-scene anchors — pass through
 * to `buildPageContents` for maximum cross-page consistency.
 *
 * `imageModel` picks the model; `spikeSubdir` keeps Pro vs Flash outputs in
 * separate Cloud Storage prefixes (`spike-pro/` vs `spike-flash/`). Returns
 * imageBase64 so the caller can accumulate it as a `prior_page` ref.
 */
export async function generateIllustrationBaked(
  sceneDescription: string,
  animalType: string,
  storyId: string,
  pageNumber: number,
  pageText: string,
  style: ArtStyle,
  characterSheets: CharacterVisualSheet[] | undefined,
  settingIdentity: SettingVisualIdentity | undefined,
  references: ReferenceImage[],
  imageModel: string,
  spikeSubdir: string,
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
    /* textPosition */ undefined,
    /* soundEffects */ undefined,
  );

  const contents = buildPageContents(references, promptText);
  const payloadBytes = JSON.stringify(contents).length;
  const tag = `[SPIKE-${spikeSubdir.toUpperCase()}]`;
  const refSummary = ` (refs: ${references.filter((r) => r.type === 'character').length} char + ${references.filter((r) => r.type === 'prior_page').length} prior-page + ${references.filter((r) => r.type === 'setting').length} setting)`;
  console.log(
    `${tag} Generating page ${pageNumber} with ${imageModel}${refSummary} [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
  const startTime = Date.now();

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: imageModel,
        contents,
        config: { responseModalities: ['IMAGE'] },
      });

      const elapsed = Date.now() - startTime;
      console.log(`${tag} Page ${pageNumber} generated in ${elapsed}ms (attempt ${attempt})`);

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
        throw new Error(`No image data in ${imageModel} response`);
      }

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/${spikeSubdir}/page-${pageNumber}-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      return { publicUrl, imageBase64: imageData, mimeType };
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`${tag} Page ${pageNumber}: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`${tag} Failed to generate page ${pageNumber} after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`${tag} All ${MAX_RETRIES} attempts failed for page ${pageNumber}; last error:`, lastError);
  return { publicUrl: `https://placehold.co/800x600/png?text=SPIKE+Failed+Page+${pageNumber}`, imageBase64: null, mimeType: 'image/png' };
}

// FC-019: exported model constants so the spike route can label variants.
export const SPIKE_IMAGE_MODEL_PRO = IMAGE_MODEL_PRO;
export const SPIKE_IMAGE_MODEL_FLASH = IMAGE_MODEL;

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

  // FC-013 review fix H3: log payload size for parity with page-gen logs.
  const payloadBytes = JSON.stringify(contents).length;
  console.log(
    `Generating character reference for "${character.name}" with ${IMAGE_MODEL} [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
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
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`Character ref "${character.name}": 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`Failed to generate character reference for "${character.name}" after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`All ${MAX_RETRIES} attempts failed for character reference "${character.name}"; last error:`, lastError);
  return {
    name: character.name,
    publicUrl: `https://placehold.co/800x600/png?text=${encodeURIComponent(character.name)}`,
    imageBase64: null,
    mimeType: 'image/png',
  };
}

/**
 * FC-012: Generate the title-page (cover) image.
 *
 * Runs after character refs (so character refs can be attached as multimodal
 * inputs) but before page 1 (so page 1 is unaffected if cover gen fails or
 * the LLM omitted titlePage). Returns null on total failure — the route then
 * persists the story without a titlePageImageUrl, and the library falls back
 * to pages[0] for the thumbnail (same as pre-FC-012 behavior).
 */
export async function generateTitlePage(
  titlePage: TitlePage,
  storyId: string,
  style: ArtStyle = 'watercolor',
  characterReferences: ReferenceImage[] = [],
): Promise<string | null> {
  const characterRefNames = characterReferences
    .filter((r) => r.type === 'character')
    .map((r) => ({ name: r.name ?? 'unnamed' }));

  const promptText = buildTitlePagePrompt(titlePage.text, titlePage.sceneDescription, style, characterRefNames);
  const contents = buildPageContents(characterReferences, promptText);

  const payloadBytes = JSON.stringify(contents).length;
  console.log(
    `Generating title page with ${IMAGE_MODEL} (with ${characterRefNames.length} character ref(s)) [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
  const startTime = Date.now();

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: { responseModalities: ['IMAGE'] },
      });

      const elapsed = Date.now() - startTime;
      console.log(`Title page generated in ${elapsed}ms (attempt ${attempt})`);

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
        throw new Error('No image data in title page response');
      }

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/title-${uuid()}.${extension}`;
      return await uploadGeneratedImage(imageData, mimeType, filename);
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`Title page: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`Failed to generate title page after ${attempt} attempts:`, error);
      break;
    }
  }

  // FC-012: title page failure does NOT degrade to a placehold.co URL — the
  // library will fall back to pages[0] which is the next-best cover. Returning
  // null lets the route persist no titlePageImageUrl and keep behavior parity
  // with pre-FC-012 stories.
  console.error(`All ${MAX_RETRIES} attempts failed for title page; last error:`, lastError);
  return null;
}

/**
 * Result from generating all illustrations (FC-013 + FC-012).
 */
export interface AllIllustrationsResult {
  pageUrls: string[];
  characterReferenceUrls: Record<string, string>; // empty when characterSheets is empty
  titlePageImageUrl: string | null;               // FC-012: null when titlePage absent or generation failed
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
  childName?: string,
): Promise<AllIllustrationsResult> {
  const startTime = Date.now();
  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const [firstPage, ...remainingPages] = sortedPages;

  // ----- Step 1 (FC-013): generate character references in parallel -----
  const characterReferenceUrls: Record<string, string> = {};
  // Map of character name -> raw image bytes/mime, for use as multimodal refs in page calls.
  // Only populated for refs that succeeded with real image data (placeholder fallbacks are URL-only).
  const characterRefImages: ReferenceImage[] = [];

  // FC-013 review fix: multimodal models often weight the first reference image
  // more heavily. Sort characterSheets so the protagonist (matched by childName)
  // is reference #1 wherever they appear. The story prompt also asks for
  // childName as the first entry, but this is a defensive belt + suspenders.
  const orderedSheets = childName
    ? [...story.characterSheets].sort((a, b) => {
        const aIsChild = a.name.toLowerCase() === childName.toLowerCase();
        const bIsChild = b.name.toLowerCase() === childName.toLowerCase();
        if (aIsChild && !bIsChild) return -1;
        if (!aIsChild && bIsChild) return 1;
        return 0;
      })
    : story.characterSheets;

  if (orderedSheets.length > 0) {
    console.log(
      `Step 2a (FC-013): generating ${orderedSheets.length} character reference image(s) in parallel: ${orderedSheets.map((c) => c.name).join(', ')}...`,
    );
    const refResults = await Promise.all(
      orderedSheets.map((c) => generateCharacterReference(c, storyId, style)),
    );
    for (const result of refResults) {
      // FC-013 review fix H2: only persist + return refs that actually produced
      // image data. Failed refs degrade gracefully — page generations skip their
      // visual ref, characterSheets[] text description still applies, and we
      // don't pollute Firestore (or any future "About the characters" UI) with
      // placehold.co URLs for what is supposed to be the canonical character
      // visual ID.
      if (result.imageBase64) {
        characterReferenceUrls[result.name] = result.publicUrl;
        characterRefImages.push({
          type: 'character',
          name: result.name,
          data: result.imageBase64,
          mimeType: result.mimeType,
        });
      } else {
        console.warn(
          `Character reference for "${result.name}" failed to produce image data — omitting from characterReferenceUrls; page generations will skip its visual ref (text description still applies).`,
        );
      }
    }
  } else {
    console.log('Step 2a (FC-013): story has no named characters — skipping character reference stage');
  }

  // ----- Step 1.5 (FC-012): generate title page (cover) ---------------------
  // Sequential between character refs and page 1: needs character refs as
  // multimodal inputs but doesn't need page 1 (the cover is its own scene).
  // Failure is non-fatal — null titlePageImageUrl means the library falls
  // back to pages[0] for the thumbnail, same as pre-FC-012 behavior.
  let titlePageImageUrl: string | null = null;
  if (story.titlePage) {
    console.log(`Step 2a.5 (FC-012): generating title page with ${characterRefImages.length} character ref(s)...`);
    titlePageImageUrl = await generateTitlePage(story.titlePage, storyId, style, characterRefImages);
  } else {
    console.log('Step 2a.5 (FC-012): story has no titlePage — skipping cover generation');
  }

  // ----- Step 2: generate page 1 (with character refs if available) -----
  // FC-015: do NOT pass pageText anymore — narration is composed as a Skia
  // overlay on the mobile reader. Pass textPosition + soundEffects so the
  // illustrator reserves negative space at the right spot.
  console.log(`Step 2b: generating page ${firstPage.pageNumber} (page 1)...`);
  const firstResult = await generateIllustration(
    firstPage.sceneDescription,
    animalType,
    storyId,
    firstPage.pageNumber,
    style,
    undefined, // FC-015: no pageText baked in
    story.characterSheets,
    story.settingIdentity,
    characterRefImages, // page 1 gets character refs but no setting ref (it IS the setting establishing shot)
    firstPage.textPosition,
    firstPage.soundEffects,
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
        undefined, // FC-015: no pageText baked in
        story.characterSheets,
        story.settingIdentity,
        pageReferences,
        page.textPosition,
        page.soundEffects,
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

  return { pageUrls, characterReferenceUrls, titlePageImageUrl };
}
