import { GoogleGenAI, HarmCategory, HarmBlockThreshold, SafetySetting } from '@google/genai';
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
  isRetryableError,
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
  MAX_CHARACTER_REFS,
} from './textVerify';
import { buildStoryPrompt } from '../prompts/story';
import { buildIllustrationPrompt } from '../prompts/illustration';
import { buildCharacterReferencePrompt, buildCastReferencePrompt } from '../prompts/characterReference';
import { buildTitlePagePrompt } from '../prompts/titlePage';
import {
  emitStageEvent,
  instrumentedGenerateContent,
  storyTag,
} from './instrumentation';
import {
  JobState,
  JobStateWriter,
  progressMessage,
} from './jobState';
import { downloadRef } from './gcsDownload';
import { extractGeneratedImage } from './imageResponse';

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

// Model constants.
// IMAGE_MODEL (every image call) moved to a GA ID in FC-045: preview IDs get
// short-notice shutdowns, and the previous image preview ID was already past
// its listed shutdown date. Any interim "thought" images in a response are
// skipped by extractGeneratedImage.
// TEXT_MODEL is DELIBERATELY still a preview ID: it serves story text AND both
// fail-closed safety classifiers (text + vision moderation), so changing it
// changes how every story is judged and requires the labelled safety
// evaluation in FC-047. gemini-models.test.ts allow-lists this one ID.
// The image model's thinking level is not controllable on @google/genai 0.7.0
// (the SDK drops thinkingLevel) — see FC-042 for the SDK upgrade.
// Measured latency / text-fidelity numbers: docs/plans/fc-045.md, Execution.
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-nano-banana-2.1';

// FC-037 layer 2: explicit, strict safety settings on EVERY Gemini call —
// never rely on model defaults for a children's product. Applied to all five
// generateContent sites (story text, page, char ref, cast ref, title page)
// plus the moderation classifier call.
//
// CIVIC_INTEGRITY deliberately omitted — irrelevant to kids' stories, and
// adds false-positive surface. Pre-approved fallback if DANGEROUS_CONTENT
// over-blocks legitimate mild-peril stories (courage/bravery): relax ONLY
// that category to BLOCK_MEDIUM_AND_ABOVE (plan fc-037 Risks).
const SAFETY_SETTINGS: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
];

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
 * Generate a story using TEXT_MODEL
 *
 * `storyId` is optional so test callers can omit it; production callers
 * (the route handler) pass it so the FC-016 / FC-017 instrumentation log
 * events are traceable to a specific story.
 */
export async function generateStory(input: StoryInput, storyId: string = 'unknown'): Promise<GeneratedStory> {
  const prompt = buildStoryPrompt(input);

  console.log(`${storyTag(storyId)} Generating story with ${TEXT_MODEL}...`);
  const startTime = Date.now();

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastError: unknown = null;
  let totalAttempts = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    totalAttempts = attempt;
    try {
      response = await instrumentedGenerateContent(storyId, 'story_text', attempt, () =>
        ai.models.generateContent({ model: TEXT_MODEL, contents: prompt, config: { safetySettings: SAFETY_SETTINGS } }),
      );
      break;
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`${storyTag(storyId)} Story text: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      emitStageEvent({ storyId, stage: 'story_text', latencyMs: Date.now() - startTime, attempts: totalAttempts, outcome: 'failure' });
      throw error;
    }
  }
  if (!response) {
    emitStageEvent({ storyId, stage: 'story_text', latencyMs: Date.now() - startTime, attempts: totalAttempts, outcome: 'failure' });
    throw lastError instanceof Error ? lastError : new Error('Story text generation failed');
  }

  const elapsed = Date.now() - startTime;
  console.log(`${storyTag(storyId)} Story generated in ${elapsed}ms`);
  emitStageEvent({ storyId, stage: 'story_text', latencyMs: elapsed, attempts: totalAttempts, outcome: 'success' });

  // FC-037: a prompt-level safety block comes back as empty candidates with
  // promptFeedback.blockReason. Surface it with safety language so
  // sanitizeFailureReason maps it to 'safety_blocked' (not generation_error).
  const storyBlockReason = response.promptFeedback?.blockReason;
  if (!response.text && storyBlockReason) {
    throw new Error(`Story text generation safety blocked: ${storyBlockReason}`);
  }

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
  let totalCallAttempts = 0;
  const generateOnce = async (): Promise<{ imageData: string; mimeType: string } | null> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      totalCallAttempts += 1;
      try {
        const response = await instrumentedGenerateContent(storyId, 'page', attempt, () =>
          ai.models.generateContent({
            model: IMAGE_MODEL,
            contents,
            config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS },
          }),
        );
        console.log(`${tag} generated in ${Date.now() - startTime}ms (attempt ${attempt})`);
        // FC-045: last non-thought image part (interim thought drafts skipped).
        const image = extractGeneratedImage(response);
        if (!image) {
          // FC-037: include the safety blockReason (when present) so any
          // propagation of this error maps to 'safety_blocked'.
          const blockReason = response.promptFeedback?.blockReason;
          throw new Error(`No image data in ${IMAGE_MODEL} response${blockReason ? ` — safety blocked: ${blockReason}` : ''}`);
        }
        return { imageData: image.data, mimeType: image.mimeType };
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
    emitStageEvent({
      storyId, stage: 'page', latencyMs: Date.now() - startTime,
      attempts: totalCallAttempts, outcome: 'success',
      detail: { pageNumber, ocrPassed: bakedTextPasses(best.score), f1: best.f1 },
    });
    return { publicUrl, imageBase64: best.imageData, mimeType: best.mimeType };
  }

  console.error(`${tag} generation failed — returning placeholder`);
  emitStageEvent({
    storyId, stage: 'page', latencyMs: Date.now() - startTime,
    attempts: totalCallAttempts, outcome: 'failure',
    detail: { pageNumber },
  });
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
  charIndex: number = 0,
): Promise<CharacterReferenceResult> {
  const promptText = buildCharacterReferencePrompt(character.name, character.description, style);
  const contents: Array<{ text: string }> = [{ text: promptText }];

  // FC-037 PII: character names include the child's real name (the story
  // prompt forces the child to be characterSheets[0]) — logs and stage
  // events use `char #<idx>` instead. Names stay in prompts, Firestore
  // user-owned docs, and progressMessage (user-facing) only.
  const charTag = `char #${charIndex}`;

  // FC-013 review fix H3: log payload size for parity with page-gen logs.
  const payloadBytes = JSON.stringify(contents).length;
  console.log(
    `Generating character reference for ${charTag} with ${IMAGE_MODEL} [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
  const startTime = Date.now();
  const safeNameSlug = character.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';

  let lastError: unknown = null;
  let totalAttempts = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    totalAttempts = attempt;
    try {
      const response = await instrumentedGenerateContent(storyId, 'char_ref', attempt, () =>
        ai.models.generateContent({
          model: IMAGE_MODEL,
          contents,
          config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS },
        }),
      );

      const elapsed = Date.now() - startTime;
      console.log(`Character reference ${charTag} generated in ${elapsed}ms (attempt ${attempt})`);

      const image = extractGeneratedImage(response);
      if (!image) {
        const blockReason = response.promptFeedback?.blockReason;
        throw new Error(`No image data in character reference response${blockReason ? ` — safety blocked: ${blockReason}` : ''}`);
      }
      const { data: imageData, mimeType } = image;

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/character-refs/${safeNameSlug}-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      emitStageEvent({
        storyId, stage: 'char_ref', latencyMs: elapsed,
        attempts: totalAttempts, outcome: 'success',
        detail: { charIndex, nameLength: character.name.length },
      });
      return { name: character.name, publicUrl, imageBase64: imageData, mimeType };
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`Character ref ${charTag}: 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(delayMs);
        continue;
      }
      console.error(`Failed to generate character reference for ${charTag} after ${attempt} attempts:`, error);
      break;
    }
  }

  console.error(`All ${MAX_RETRIES} attempts failed for character reference ${charTag}; last error:`, lastError);
  emitStageEvent({
    storyId, stage: 'char_ref', latencyMs: Date.now() - startTime,
    attempts: totalAttempts, outcome: 'failure',
    detail: { charIndex, nameLength: character.name.length },
  });
  return {
    name: character.name,
    // FC-037 PII: static text — the previous ?text=<name> embedded the
    // child's name in an external placehold.co request. (URL is filtered
    // out before persistence anyway; this closes the external-request leak.)
    publicUrl: 'https://placehold.co/800x600/png?text=Character',
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
  // FC-037 PII: log the count only — character names include the child's name.
  console.log(`Generating CAST reference (${characters.length} chars) with ${IMAGE_MODEL}...`);
  const startTime = Date.now();

  let lastError: unknown = null;
  let totalAttempts = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    totalAttempts = attempt;
    try {
      const response = await instrumentedGenerateContent(storyId, 'cast_ref', attempt, () =>
        ai.models.generateContent({
          model: IMAGE_MODEL,
          contents,
          config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS },
        }),
      );
      const elapsed = Date.now() - startTime;
      console.log(`Cast reference generated in ${elapsed}ms (attempt ${attempt})`);
      const image = extractGeneratedImage(response);
      if (!image) {
        const blockReason = response.promptFeedback?.blockReason;
        throw new Error(`No image data in cast reference response${blockReason ? ` — safety blocked: ${blockReason}` : ''}`);
      }
      const { data: imageData, mimeType } = image;
      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/character-refs/cast-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      emitStageEvent({
        storyId, stage: 'cast_ref', latencyMs: elapsed,
        attempts: totalAttempts, outcome: 'success',
        detail: { charCount: characters.length },
      });
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
  emitStageEvent({
    storyId, stage: 'cast_ref', latencyMs: Date.now() - startTime,
    attempts: totalAttempts, outcome: 'failure',
    detail: { charCount: characters.length },
  });
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
  let totalAttempts = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    totalAttempts = attempt;
    try {
      const response = await instrumentedGenerateContent(storyId, 'title_page', attempt, () =>
        ai.models.generateContent({
          model: IMAGE_MODEL,
          contents,
          config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS },
        }),
      );

      const elapsed = Date.now() - startTime;
      console.log(`Title page generated in ${elapsed}ms (attempt ${attempt})`);

      const image = extractGeneratedImage(response);
      if (!image) {
        const blockReason = response.promptFeedback?.blockReason;
        throw new Error(`No image data in title page response${blockReason ? ` — safety blocked: ${blockReason}` : ''}`);
      }
      const { data: imageData, mimeType } = image;

      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      const filename = `stories/${storyId}/title-${uuid()}.${extension}`;
      const publicUrl = await uploadGeneratedImage(imageData, mimeType, filename);
      emitStageEvent({
        storyId, stage: 'title_page', latencyMs: elapsed,
        attempts: totalAttempts, outcome: 'success',
      });
      return publicUrl;
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
  emitStageEvent({
    storyId, stage: 'title_page', latencyMs: Date.now() - startTime,
    attempts: totalAttempts, outcome: 'failure',
  });
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

// FC-025 L-5: noopWriter removed. Previously generateAllIllustrations
// accepted `opts.writer?` and silently fell back to a no-op. A future
// production caller that forgot to pass a writer would have gotten broken
// resume capability with zero indication. opts is now REQUIRED — tests
// construct their own no-op writer inline if needed (see resume.test.ts).

/**
 * Generate all illustrations for a story (FC-020 pipeline; FC-017 Phase 2 resume-aware).
 *
 *   1. Character model-sheet refs — parallel (capped at MAX_CHARACTER_REFS images).
 *   2. Cast lineup (>1 character) + title page — parallel.
 *   3. First CANONICAL_ANCHOR_PAGES pages — SEQUENTIAL, each baked + OCR-verified,
 *      becoming fixed canonical anchors.
 *   4. Remaining pages — PARALLEL (bounded concurrency), each referencing char
 *      refs + cast + the fixed anchors. Text is baked into every page.
 *
 * Stories with no named characters skip steps 1-2; pages still anchor on the
 * first rendered pages.
 *
 * FC-017 Phase 2: optional `opts.state` carries the resume payload (what
 * artifacts are already done). Anything in state is SKIPPED on this run; for
 * artifacts that downstream phases need as multimodal inputs (char-refs, cast,
 * anchor pages), the bytes are re-downloaded from GCS. `opts.writer` receives
 * per-artifact + per-progress updates so a crashed worker can be resumed by
 * a future run reading the persisted state.
 *
 * FC-025 L-5: opts is REQUIRED. Tests construct their own no-op writer + an
 * emptyJobState(storyId) if they don't need persistence.
 */
export async function generateAllIllustrations(
  story: GeneratedStory,
  storyId: string,
  animalType: string,
  style: ArtStyle,
  childName: string | undefined,
  opts: { state: JobState; writer: JobStateWriter },
): Promise<AllIllustrationsResult> {
  const { state, writer } = opts;
  const startTime = Date.now();
  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);

  // ----- Step 1 (FC-013): generate character references in parallel -----
  // FC-017 Phase 2: pre-populate from state for any refs already persisted on a
  // prior attempt. Bytes are re-downloaded from GCS so they remain available as
  // multimodal inputs to downstream phases.
  const characterReferenceUrls: Record<string, string> = { ...state.characterReferenceUrls };
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

  // FC-020 (review HIGH): cap character REFERENCE IMAGES so a many-character
  // story can't blow past Gemini's ~14-image multimodal cap and fail every
  // page into placeholders. Excess characters still appear in the TEXTUAL
  // character sheets passed to the prompt; only their ref images are dropped
  // (protagonist is ordered first, so the most important refs are kept).
  const sheetsForRefs = orderedSheets.slice(0, MAX_CHARACTER_REFS);
  if (orderedSheets.length > sheetsForRefs.length) {
    console.warn(
      `Story has ${orderedSheets.length} characters; capping reference images at ${MAX_CHARACTER_REFS} ` +
      `(${orderedSheets.length - MAX_CHARACTER_REFS} character(s) get textual sheets only).`,
    );
  }

  if (sheetsForRefs.length > 0) {
    // FC-017 Phase 2: partition into already-done (rehydrate from GCS) vs todo (generate).
    const todo: typeof sheetsForRefs = [];
    const alreadyDone: typeof sheetsForRefs = [];
    for (const c of sheetsForRefs) {
      if (state.characterReferenceUrls[c.name]) alreadyDone.push(c);
      else todo.push(c);
    }
    await writer.saveProgress('char-refs', 0, sheetsForRefs.length, progressMessage('char-refs', 0, sheetsForRefs.length));

    if (alreadyDone.length > 0) {
      console.log(
        `${storyTag(storyId)} Step 2a (FC-013/FC-017 resume): re-downloading ${alreadyDone.length} prior char ref(s) from GCS`,
      );
      const downloaded = await Promise.all(alreadyDone.map(async (c) => {
        const url = state.characterReferenceUrls[c.name];
        const bytes = await downloadRef(url);
        return { name: c.name, bytes };
      }));
      downloaded.forEach((r, i) => {
        if (r.bytes) {
          characterRefImages.push({ type: 'character', name: r.name, data: r.bytes.data, mimeType: r.bytes.mimeType });
        } else {
          // GCS download failed for a previously-persisted ref. Don't regenerate
          // — that would burn cost on a transient error. Page generation will
          // proceed without this ref's visual (text description still applies).
          console.warn(`Character ref char #${i} rehydrate failed — proceeding without its visual.`);
        }
      });
    }

    if (todo.length > 0) {
      // FC-037 PII: log the count only — character names include the child's name.
      console.log(
        `${storyTag(storyId)} Step 2a (FC-013): generating ${todo.length} character reference image(s) in parallel...`,
      );
      const charRefStart = Date.now();
      const refResults = await Promise.all(
        todo.map((c, i) => generateCharacterReference(c, storyId, style, i)),
      );
      const successCount = refResults.filter((r) => r.imageBase64).length;
      emitStageEvent({
        storyId, stage: 'char_refs_total', latencyMs: Date.now() - charRefStart,
        charCount: todo.length,
        outcome: successCount === todo.length ? 'success' : (successCount > 0 ? 'partial' : 'failure'),
        detail: { successCount, totalCount: todo.length, alreadyDoneCount: alreadyDone.length },
      });
      let doneCount = alreadyDone.length;
      for (const [resultIndex, result] of refResults.entries()) {
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
          // FC-017 Phase 2: persist this ref the moment it lands so a crash
          // mid-batch only loses the not-yet-completed refs.
          await writer.saveCharacterReference(result.name, result.publicUrl);
          doneCount += 1;
          await writer.saveProgress('char-refs', doneCount, sheetsForRefs.length,
            progressMessage('char-refs', doneCount, sheetsForRefs.length, { charName: result.name }));
        } else {
          // FC-037 PII: log the char index, not the name.
          console.warn(
            `Character reference for char #${resultIndex} failed to produce image data — omitting from characterReferenceUrls; page generations will skip its visual ref (text description still applies).`,
          );
        }
      }
    }
  } else {
    console.log(`${storyTag(storyId)} Step 2a (FC-013): story has no named characters — skipping character reference stage`);
  }

  // ----- Step 2 (FC-012 + FC-020): cast lineup + title page, in parallel -----
  // Both depend only on the character refs (not on any page), so run together.
  // The cast lineup (only when >1 character) pins relative scale and becomes a
  // fixed canonical reference on every page. Both failures are non-fatal: a null
  // title falls back to pages[0]; a failed cast just means pages run without it.
  //
  // FC-017 Phase 2: skip whichever is already in state. Cast bytes (used as a
  // multimodal ref on every page) get rehydrated from GCS on skip; title bytes
  // are never used downstream (cover-only) so no rehydrate needed.
  const needsCast = orderedSheets.length > 1;
  // FC-025 B-6: "already done" must include "previously attempted and failed"
  // (recorded via state.castAttempted / state.titleAttempted). Without this,
  // a null persisted by a prior failed run looked identical to "not yet
  // tried" and retried forever, burning Gemini cost per resume.
  const castAlreadyDone = !!state.castReferenceUrl || state.castAttempted === true;
  const titleAlreadyDone = !!state.titlePageImageUrl || state.titleAttempted === true;
  const castTodo = needsCast && !castAlreadyDone;
  const titleTodo = !!story.titlePage && !titleAlreadyDone;

  if (castTodo || titleTodo) {
    console.log(
      `${storyTag(storyId)} Step 2b: generating ${[castTodo && 'cast lineup', titleTodo && 'title page'].filter(Boolean).join(' + ')} in parallel with ${characterRefImages.length} character ref(s)...`,
    );
  }

  const [castResult, generatedTitleUrl] = await Promise.all([
    castTodo ? generateCastReference(orderedSheets, storyId, style) : Promise.resolve(null),
    titleTodo ? generateTitlePage(story.titlePage!, storyId, style, characterRefImages) : Promise.resolve(null),
  ]);

  let castReferenceUrl: string | null = state.castReferenceUrl ?? null;
  let titlePageImageUrl: string | null = state.titlePageImageUrl ?? null;
  const baseRefs: ReferenceImage[] = [...characterRefImages];

  // Cast: either freshly generated or rehydrate from GCS on resume.
  if (castResult && castResult.imageBase64) {
    castReferenceUrl = castResult.publicUrl;
    baseRefs.push({ type: 'cast', data: castResult.imageBase64, mimeType: castResult.mimeType });
    await writer.saveCastReference(castResult.publicUrl);
  } else if (castTodo) {
    console.warn(`${storyTag(storyId)} Cast lineup reference failed to produce image data — pages run without it.`);
    await writer.saveCastReference(null);
  } else if (castAlreadyDone) {
    // FC-025 B-6: distinguish "had URL → rehydrate" from "attempted-and-failed
    // → skip rehydrate". Without this distinction the `!` non-null assertion
    // crashed on castAttempted-but-no-URL state.
    if (state.castReferenceUrl) {
      const bytes = await downloadRef(state.castReferenceUrl);
      if (bytes) baseRefs.push({ type: 'cast', data: bytes.data, mimeType: bytes.mimeType });
      else console.warn(`${storyTag(storyId)} Cast ref rehydrate from GCS failed on resume — pages run without it.`);
    } else {
      console.log(`${storyTag(storyId)} Cast ref attempted in prior run and failed — pages run without it.`);
    }
  }

  // Title: persist if freshly generated. No bytes needed downstream.
  if (generatedTitleUrl) {
    titlePageImageUrl = generatedTitleUrl;
    await writer.saveTitlePage(generatedTitleUrl);
  } else if (titleTodo) {
    // Generation attempted and returned null (failure). FC-012 behavior: don't
    // persist a placeholder — library falls back to pages[0]. Record the
    // failure so a resume doesn't keep retrying.
    await writer.saveTitlePage(null);
  }

  // ----- Step 3 (FC-020): pages with pin-first-K canonical anchoring ---------
  // The first K pages generate SEQUENTIALLY so each anchors on the prior
  // rendered page(s); those K become FIXED canonical anchors. The rest then
  // generate in PARALLEL (bounded concurrency), each referencing the same fixed
  // anchors — no inter-page dependency, so a late page's drift can't propagate
  // and the batch parallelizes safely. Text is baked + OCR-verified inside
  // generateIllustration.
  //
  // FC-017 Phase 2: pages already in state.pageUrls are SKIPPED. Anchor pages
  // skipped on resume get their bytes re-downloaded from GCS so the parallel
  // batch can still reference them.
  const { sequential: seqPages, parallel: parPages } = splitForAnchoring(sortedPages, CANONICAL_ANCHOR_PAGES);
  const results = new Map<number, string>();
  const canonicalAnchors: ReferenceImage[] = [];

  // Pre-load already-done page URLs from state.
  for (const page of sortedPages) {
    const prior = state.pageUrls[String(page.pageNumber)];
    if (prior) results.set(page.pageNumber, prior.url);
  }

  await writer.saveProgress('anchor-pages', 0, seqPages.length, progressMessage('anchor-pages', 0, seqPages.length));
  console.log(`${storyTag(storyId)} Step 3a: ${seqPages.length} canonical-anchor page(s) sequential...`);
  const anchorPagesStart = Date.now();
  let anchorCompletedCount = 0;
  for (const page of seqPages) {
    const priorAnchor = state.pageUrls[String(page.pageNumber)];
    if (priorAnchor) {
      // Skipped on resume. Rehydrate bytes from GCS so later pages can anchor on it.
      if (canonicalAnchors.length < CANONICAL_ANCHOR_PAGES) {
        const bytes = await downloadRef(priorAnchor.url);
        if (bytes) {
          canonicalAnchors.push({ type: 'prior_page', pageNumber: page.pageNumber, data: bytes.data, mimeType: bytes.mimeType });
        } else {
          console.warn(`${storyTag(storyId)} Anchor page ${page.pageNumber} rehydrate from GCS failed — downstream pages may drift.`);
        }
      }
      anchorCompletedCount += 1;
      await writer.saveProgress('anchor-pages', anchorCompletedCount, seqPages.length,
        progressMessage('anchor-pages', anchorCompletedCount, seqPages.length, { pageNumber: page.pageNumber }));
      continue;
    }
    const refs = [...baseRefs, ...canonicalAnchors];
    const r = await generateIllustration(
      page.sceneDescription, animalType, storyId, page.pageNumber, page.text, style,
      story.characterSheets, story.settingIdentity, refs, page.soundEffects, page.emphasizedWords,
    );
    results.set(page.pageNumber, r.publicUrl);
    if (r.imageBase64 && canonicalAnchors.length < CANONICAL_ANCHOR_PAGES) {
      canonicalAnchors.push({ type: 'prior_page', pageNumber: page.pageNumber, data: r.imageBase64, mimeType: r.mimeType });
    }
    // FC-025 B-2: only persist to pageUrls when generation produced real
    // image data. Placeholder fallback (imageBase64 === null) means a
    // transient or permanent generation failure — DON'T persist it; let
    // resume retry. Without this guard, the placehold.co URL was recorded
    // as "done" and locked in permanently across every future resume.
    if (r.imageBase64 !== null) {
      await writer.savePage(page.pageNumber, {
        url: r.publicUrl,
        ocrPassed: true,
        attempts: 1,
      });
    }
    anchorCompletedCount += 1;
    await writer.saveProgress('anchor-pages', anchorCompletedCount, seqPages.length,
      progressMessage('anchor-pages', anchorCompletedCount, seqPages.length, { pageNumber: page.pageNumber }));
  }
  if (seqPages.length > 0) {
    emitStageEvent({
      storyId, stage: 'anchor_pages_total', latencyMs: Date.now() - anchorPagesStart,
      pageCount: seqPages.length, outcome: 'success',
    });
  }

  if (parPages.length > 0) {
    const todoParPages = parPages.filter((p) => !state.pageUrls[String(p.pageNumber)]);
    await writer.saveProgress('parallel-pages', parPages.length - todoParPages.length, parPages.length,
      progressMessage('parallel-pages', parPages.length - todoParPages.length, parPages.length));

    if (todoParPages.length > 0) {
      const refs = [...baseRefs, ...canonicalAnchors];
      console.log(
        `${storyTag(storyId)} Step 3b: ${todoParPages.length} parallel page(s) ${todoParPages.map((p) => p.pageNumber).join(', ')} (concurrency ${PAGE_GEN_CONCURRENCY}, ${refs.length} ref(s); ${parPages.length - todoParPages.length} already done from prior attempt)`,
      );
      const parPagesStart = Date.now();
      // FC-025 H-8: in-batch atomic counter so per-page saveProgress can
      // report real progress. Previously the only saveProgress for this
      // phase fired ONCE before the batch started, leaving the mobile
      // progress bar frozen for ~30-60s during the longest phase.
      let inBatchCompletedCount = parPages.length - todoParPages.length;
      const parResults = await mapWithConcurrency(todoParPages, PAGE_GEN_CONCURRENCY, async (page) => {
        const r = await generateIllustration(
          page.sceneDescription, animalType, storyId, page.pageNumber, page.text, style,
          story.characterSheets, story.settingIdentity, refs, page.soundEffects, page.emphasizedWords,
        );
        // FC-017 Phase 2 + FC-025 B-2: per-page persistence the moment it
        // lands so a crash mid-batch only loses the not-yet-completed pages.
        // Skip persistence for placeholder fallback so resume can retry.
        if (r.imageBase64 !== null) {
          await writer.savePage(page.pageNumber, {
            url: r.publicUrl,
            ocrPassed: true,
            attempts: 1,
          });
        }
        inBatchCompletedCount += 1;
        await writer.saveProgress('parallel-pages', inBatchCompletedCount, parPages.length,
          progressMessage('parallel-pages', inBatchCompletedCount, parPages.length, { pageNumber: page.pageNumber }));
        return r;
      });
      todoParPages.forEach((page, i) => results.set(page.pageNumber, parResults[i].publicUrl));
      emitStageEvent({
        storyId, stage: 'parallel_pages_total', latencyMs: Date.now() - parPagesStart,
        pageCount: todoParPages.length, outcome: 'success',
        detail: { concurrency: PAGE_GEN_CONCURRENCY, alreadyDoneCount: parPages.length - todoParPages.length },
      });
    }
  }

  const pageUrls = sortedPages.map((page) => results.get(page.pageNumber)!);

  // FC-017 Phase 2: release in-process ref bytes now that all page generation
  // is complete. Bytes are still on the heap until the next GC, but clearing
  // the references makes them eligible. Cosmetic on a single run; matters
  // more for any future architecture where the worker holds state across
  // multiple stories on one instance.
  characterRefImages.length = 0;
  baseRefs.length = 0;
  canonicalAnchors.length = 0;

  const elapsed = Date.now() - startTime;
  console.log(
    `${storyTag(storyId)} All ${story.pages.length} illustrations + ${Object.keys(characterReferenceUrls).length} char ref(s)` +
    `${castReferenceUrl ? ' + cast ref' : ''} generated in ${elapsed}ms`,
  );
  emitStageEvent({
    storyId, stage: 'all_illustrations', latencyMs: elapsed,
    pageCount: story.pages.length, charCount: Object.keys(characterReferenceUrls).length,
    outcome: 'success',
    detail: { hasCastRef: castReferenceUrl !== null, hasTitlePage: titlePageImageUrl !== null },
  });

  return { pageUrls, characterReferenceUrls, titlePageImageUrl, castReferenceUrl };
}

/**
 * FC-037 layer 3: thin production wrapper the moderation gate injects as its
 * `generate` fn. One TEXT_MODEL call with explicit SAFETY_SETTINGS, no retry
 * (fail-closed is the moderation module's job — any error/timeout there
 * blocks), instrumented as a 'moderation' call. Returns the raw model text;
 * the caller (moderation.ts) owns parsing + verdict logic.
 */
export async function generateModerationText(prompt: string, storyId: string = 'unknown'): Promise<string> {
  const response = await instrumentedGenerateContent(storyId, 'moderation', 1, () =>
    ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
      config: { safetySettings: SAFETY_SETTINGS },
    }),
  );
  return response.text || '';
}

/**
 * FC-041: sibling of generateModerationText for the VISION moderation gate.
 * Sends a fixed text instruction PLUS the page image as an inline input part
 * to TEXT_MODEL, so the classifier reasons over the actual pixels + any
 * baked-in text (not just the story's page text, which the FC-037 text gate
 * already covered). The `{ text, inlineData }` contents array is the exact
 * multimodal-INPUT shape gemini.ts already sends for character/cast/anchor
 * references (see buildPageContents), so no new SDK capability is required —
 * @google/genai 0.7.0's ContentListUnion accepts a PartUnion[] with an
 * inlineData Blob (verified during execution step 1 against the SDK types).
 *
 * One call, no retry (fail-closed is visionModeration.ts's job — any
 * error/timeout there blocks), instrumented as a 'vision_moderation' call.
 * Returns the raw model text; the caller owns parsing + verdict logic.
 */
export async function generateVisionModerationText(
  prompt: string,
  image: { data: string; mimeType: string },
  storyId: string = 'unknown',
): Promise<string> {
  const response = await instrumentedGenerateContent(storyId, 'vision_moderation', 1, () =>
    ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ text: prompt }, { inlineData: { data: image.data, mimeType: image.mimeType } }],
      config: { safetySettings: SAFETY_SETTINGS },
    }),
  );
  return response.text || '';
}
