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
} from '../types';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import {
  BakedTextScore,
  wordTokens,
  scoreText,
  bakedTextPasses,
  bakedTextF1,
  splitForAnchoring,
  mapWithConcurrency,
  PROD_TEXT_GEN_ATTEMPTS,
  MAX_TEXT_GEN_ATTEMPTS,
  TEXT_RECALL_MIN,
  TEXT_PRECISION_MIN,
  CANONICAL_ANCHOR_PAGES,
  PAGE_GEN_CONCURRENCY,
} from './textVerify';
import { buildStoryPrompt } from '../prompts/story';
import { buildIllustrationPrompt } from '../prompts/illustration';
import { buildCharacterReferencePrompt, buildCastReferencePrompt } from '../prompts/characterReference';
import { buildTitlePagePrompt } from '../prompts/titlePage';

// Initialize Gemini client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

// Initialize Cloud Storage
const storage = new Storage();
const bucketName = process.env.STORAGE_BUCKET!;
const bucket = storage.bucket(bucketName);

// FC-019 text-verify: Cloud Vision client for OCR-based baked-text validation.
// Lazily constructed so non-spike paths don't pay the init cost.
let _vision: ImageAnnotatorClient | null = null;
function visionClient(): ImageAnnotatorClient {
  if (!_vision) _vision = new ImageAnnotatorClient();
  return _vision;
}

/**
 * OCR the image via Cloud Vision and score the baked narration against the
 * intended text (recall + precision; see textVerify.scoreText). `intendedText`
 * must already include any sound-effect words (they are legitimately rendered).
 * On OCR error returns perfect scores (fail open — never block a page on an OCR
 * outage).
 */
async function scoreBakedText(imageBase64: string, intendedText: string): Promise<BakedTextScore> {
  if (wordTokens(intendedText).length === 0) return { recall: 1, precision: 1 };
  try {
    const [result] = await visionClient().textDetection({ image: { content: imageBase64 } });
    const detected = result.fullTextAnnotation?.text ?? result.textAnnotations?.[0]?.description ?? '';
    return scoreText(intendedText, detected);
  } catch (e) {
    console.warn('[TEXT-VERIFY] OCR failed, failing open (treating as pass):', e);
    return { recall: 1, precision: 1 };
  }
}

// Model constants
// Text: gemini-3-flash-preview
// Images: gemini-3.1-flash-image-preview ("Nano Banana 2", launched 2026-02-26).
//   ~90% text accuracy (vs ~94% on gemini-3-pro-image-preview) in exchange for
//   4-6s per image (vs 24-35s) and ~50% lower cost ($0.067 vs $0.13 per 1K image).
//   User override of FC-002; full benchmark plan deferred.
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

// Retry configuration for handling transient 5xx errors
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
 * Check if an error is retryable. FC-020: broadened beyond 503. A transient
 * 500 INTERNAL from Gemini was previously NOT retried and dropped a page to a
 * placeholder. We now retry all transient server-side 5xx (500/502/503/504),
 * Gemini's status strings, and common network resets, under the existing
 * jittered exponential backoff. 501 (Not Implemented) is intentionally excluded
 * — retrying it can't succeed.
 */
function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const errorStr = String(error);
    return (
      /\b(500|502|503|504)\b/.test(errorStr) ||
      errorStr.includes('UNAVAILABLE') ||
      errorStr.includes('INTERNAL') ||
      errorStr.includes('high demand') ||
      errorStr.includes('ECONNRESET') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('fetch failed') ||
      errorStr.includes('socket hang up')
    );
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

      // FC-020: narration is baked into the image; soundEffects + emphasizedWords
      // are baked illustration guidance. (textPosition was removed with the Skia
      // overlay.) Validate these optional fields with graceful fallback so one
      // bad value doesn't abort the whole story.
      //
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
  // FC-019 text-verify: populated when verifyText is on. Both axes of the
  // OCR check on the kept candidate (see scoreBakedText).
  textRecall?: number;       // fraction of intended words present in the OCR
  textPrecision?: number;    // fraction of OCR'd words that were intended
  textGenAttempts?: number;  // how many generations it took to pass the check
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
  type: 'character' | 'setting' | 'prior_page' | 'cast';
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
    } else if (ref.type === 'cast') {
      // FC-019: cast lineup — all characters together at correct relative scale.
      contents.push({
        text: 'CAST LINEUP reference: this shows ALL of the book\'s characters together at their CORRECT RELATIVE SIZES. CRITICAL: preserve these size relationships on the page below — each character must be the same size relative to the others as shown here (do not make a small character large or vice versa), and match each character\'s identity exactly.',
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

/**
 * FC-020: production page illustrator. Bakes the narration text INTO the image
 * (Gemini Flash), then OCR-verifies it and regenerates (up to `maxAttempts`)
 * when the rendered text fails recall/precision (jumbled or hallucinated text —
 * see scoreBakedText). Character / cast / prior-page references pass through to
 * buildPageContents for cross-page consistency.
 *
 * Returns imageBase64 so the caller can pin the rendered page as a canonical
 * anchor for subsequent pages.
 */
export async function generateIllustration(
  sceneDescription: string,
  animalType: string,
  storyId: string,
  pageNumber: number,
  pageText: string,
  style: ArtStyle,
  characterSheets: CharacterVisualSheet[] | undefined,
  settingIdentity: SettingVisualIdentity | undefined,
  references: ReferenceImage[] = [],
  soundEffects?: string[],
  emphasizedWords?: string[],
  opts: { verifyText?: boolean; maxAttempts?: number } = {},
): Promise<IllustrationResult> {
  const verifyText = opts.verifyText ?? true;
  const maxAttempts = opts.maxAttempts ?? PROD_TEXT_GEN_ATTEMPTS;

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
    soundEffects,
    emphasizedWords,
  );

  const contents = buildPageContents(references, promptText);
  const payloadBytes = JSON.stringify(contents).length;
  const tag = `[page ${pageNumber}]`;
  const refSummary = ` (refs: ${references.filter((r) => r.type === 'character').length} char + ${references.filter((r) => r.type === 'cast').length} cast + ${references.filter((r) => r.type === 'prior_page').length} anchor)`;
  console.log(`${tag} Generating with ${IMAGE_MODEL}${refSummary} [payload ~${Math.round(payloadBytes / 1024)}KB]...`);
  const startTime = Date.now();

  // One generation attempt, with the existing 503/5xx jittered-backoff retry.
  // Returns raw bytes (not uploaded) so the verify loop can OCR before keeping.
  // Returns null only when all transient retries are exhausted (regenerating
  // for text quality won't help there, so the outer loop stops on null).
  const generateOnce = async (): Promise<{ imageData: string; mimeType: string } | null> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: IMAGE_MODEL,
          contents,
          config: { responseModalities: ['IMAGE'] },
        });
        console.log(`${tag} generated in ${Date.now() - startTime}ms (attempt ${attempt})`);
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
        if (!imageData) throw new Error(`No image data in ${IMAGE_MODEL} response`);
        return { imageData, mimeType };
      } catch (error) {
        lastError = error;
        if (isRetryableError(error) && attempt < MAX_RETRIES) {
          const delayMs = jitteredBackoffMs(attempt);
          console.log(`${tag} retryable error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
          await sleep(delayMs);
          continue;
        }
        console.error(`${tag} failed after ${attempt} attempts:`, error);
        break;
      }
    }
    console.error(`${tag} all ${MAX_RETRIES} attempts failed; last error:`, lastError);
    return null;
  };

  // OCR verify-and-regenerate. Sound-effect words are folded into the intended
  // set so they don't read as "extra" and depress precision. Keep the best-F1
  // candidate so a later worse roll never wins.
  const intendedForOcr = [pageText, ...(soundEffects ?? [])].join(' ');
  const maxGenAttempts = verifyText ? maxAttempts : 1;
  let best: { imageData: string; mimeType: string; score: BakedTextScore; f1: number } | null = null;

  for (let genAttempt = 1; genAttempt <= maxGenAttempts; genAttempt++) {
    const produced = await generateOnce();
    if (!produced) break; // transient failure exhausted — stop
    if (!verifyText) {
      best = { ...produced, score: { recall: NaN, precision: NaN }, f1: NaN };
      break;
    }
    const score = await scoreBakedText(produced.imageData, intendedForOcr);
    const f1 = bakedTextF1(score);
    console.log(
      `${tag} text-verify recall=${score.recall.toFixed(2)} precision=${score.precision.toFixed(2)} ` +
      `(gen ${genAttempt}/${maxGenAttempts}, min recall ${TEXT_RECALL_MIN}/precision ${TEXT_PRECISION_MIN})`,
    );
    if (!best || f1 > best.f1) best = { ...produced, score, f1 };
    if (bakedTextPasses(score)) break;
    if (genAttempt < maxGenAttempts) console.log(`${tag} text below threshold — regenerating...`);
  }

  if (best) {
    const extension = best.mimeType.includes('jpeg') || best.mimeType.includes('jpg') ? 'jpg' : 'png';
    const filename = `stories/${storyId}/page-${pageNumber}-${uuid()}.${extension}`;
    const publicUrl = await uploadGeneratedImage(best.imageData, best.mimeType, filename);
    return { publicUrl, imageBase64: best.imageData, mimeType: best.mimeType };
  }

  console.error(`${tag} generation failed — returning placeholder`);
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
 * FC-019: Generate a CAST LINEUP reference — all characters together at
 * correct relative scale on a white background. Fixes the relative-size
 * drift between characters that per-character model sheets can't (each sheet
 * shows one character alone, so the model has no size-ratio anchor).
 * Generated with Flash (cheap, parity with model-sheet generation); the
 * resulting image is fed as a fixed canonical reference to page generation.
 */
export async function generateCastReference(
  characters: CharacterVisualSheet[],
  storyId: string,
  style: ArtStyle = 'watercolor',
): Promise<CharacterReferenceResult> {
  const promptText = buildCastReferencePrompt(characters, style);
  const contents: Array<{ text: string }> = [{ text: promptText }];
  console.log(`Generating CAST reference (${characters.length} chars: ${characters.map((c) => c.name).join(', ')}) with ${IMAGE_MODEL}...`);
  const startTime = Date.now();

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: { responseModalities: ['IMAGE'] },
      });
      console.log(`Cast reference generated in ${Date.now() - startTime}ms (attempt ${attempt})`);
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
        throw new Error('No image data in cast reference response');
      }
      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/character-refs/cast-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      return { name: '__cast__', publicUrl, imageBase64: imageData, mimeType };
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`Cast ref: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`Failed to generate cast reference after ${attempt} attempts:`, error);
      break;
    }
  }
  console.error(`All ${MAX_RETRIES} attempts failed for cast reference; last error:`, lastError);
  return { name: '__cast__', publicUrl: '', imageBase64: null, mimeType: 'image/png' };
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
  castReferenceUrl: string | null;                // FC-020: cast lineup ref (null when <2 characters or gen failed)
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

  // ----- Step 2 (FC-012 + FC-020): cast lineup + title page, in parallel -----
  // Both depend only on the character refs (not on any page), so run together.
  // The cast lineup (only when >1 character) pins relative scale and becomes a
  // fixed canonical reference on every page. Both failures are non-fatal: a null
  // title falls back to pages[0]; a failed cast just means pages run without it.
  const needsCast = orderedSheets.length > 1;
  console.log(
    `Step 2b: generating ${needsCast ? 'cast lineup + ' : ''}title page in parallel with ${characterRefImages.length} character ref(s)...`,
  );
  const [castResult, titlePageImageUrl] = await Promise.all([
    needsCast ? generateCastReference(orderedSheets, storyId, style) : Promise.resolve(null),
    story.titlePage ? generateTitlePage(story.titlePage, storyId, style, characterRefImages) : Promise.resolve(null),
  ]);

  let castReferenceUrl: string | null = null;
  const baseRefs: ReferenceImage[] = [...characterRefImages];
  if (castResult && castResult.imageBase64) {
    castReferenceUrl = castResult.publicUrl;
    baseRefs.push({ type: 'cast', data: castResult.imageBase64, mimeType: castResult.mimeType });
  } else if (needsCast) {
    console.warn('Cast lineup reference failed to produce image data — pages run without it.');
  }

  // ----- Step 3 (FC-020): pages with pin-first-K canonical anchoring ---------
  // The first K pages generate SEQUENTIALLY so each anchors on the prior
  // rendered page(s); those K become FIXED canonical anchors. The rest then
  // generate in PARALLEL (bounded concurrency), each referencing the same fixed
  // anchors — no inter-page dependency, so a late page's drift can't propagate
  // and the batch parallelizes safely. Text is baked + OCR-verified inside
  // generateIllustration.
  const { sequential: seqPages, parallel: parPages } = splitForAnchoring(sortedPages, CANONICAL_ANCHOR_PAGES);
  const results = new Map<number, string>();
  const canonicalAnchors: ReferenceImage[] = [];

  console.log(`Step 3a: generating ${seqPages.length} canonical-anchor page(s) sequentially...`);
  for (const page of seqPages) {
    const refs = [...baseRefs, ...canonicalAnchors];
    const r = await generateIllustration(
      page.sceneDescription, animalType, storyId, page.pageNumber, page.text, style,
      story.characterSheets, story.settingIdentity, refs, page.soundEffects, page.emphasizedWords,
    );
    results.set(page.pageNumber, r.publicUrl);
    if (r.imageBase64 && canonicalAnchors.length < CANONICAL_ANCHOR_PAGES) {
      canonicalAnchors.push({ type: 'prior_page', pageNumber: page.pageNumber, data: r.imageBase64, mimeType: r.mimeType });
    }
  }

  if (parPages.length > 0) {
    const refs = [...baseRefs, ...canonicalAnchors];
    console.log(
      `Step 3b: generating pages ${parPages.map((p) => p.pageNumber).join(', ')} in parallel (concurrency ${PAGE_GEN_CONCURRENCY}) with ${refs.length} reference(s)...`,
    );
    const parResults = await mapWithConcurrency(parPages, PAGE_GEN_CONCURRENCY, (page) =>
      generateIllustration(
        page.sceneDescription, animalType, storyId, page.pageNumber, page.text, style,
        story.characterSheets, story.settingIdentity, refs, page.soundEffects, page.emphasizedWords,
      ),
    );
    parPages.forEach((page, i) => results.set(page.pageNumber, parResults[i].publicUrl));
  }

  const pageUrls = sortedPages.map((page) => results.get(page.pageNumber)!);

  const elapsed = Date.now() - startTime;
  console.log(
    `All ${story.pages.length} illustrations + ${Object.keys(characterReferenceUrls).length} char ref(s)` +
    `${castReferenceUrl ? ' + cast ref' : ''} generated in ${elapsed}ms`,
  );

  return { pageUrls, characterReferenceUrls, titlePageImageUrl, castReferenceUrl };
}
