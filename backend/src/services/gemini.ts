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

// Initialize Gemini client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

// Initialize Cloud Storage
const storage = new Storage();
const bucketName = process.env.STORAGE_BUCKET!;
const bucket = storage.bucket(bucketName);

// Model constants
// Using gemini-3-flash for text (faster, smarter successor to 2.0-flash which is deprecated Mar 2026)
// Using gemini-3-pro-image-preview for images (best text rendering - 94% accuracy)
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3-pro-image-preview';

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

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: prompt,
  });

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
 * Generate an illustration using Gemini 3 Pro Image (Nano Banana Pro)
 * Uses generateContent API with IMAGE response modality for best text rendering
 * Achieves ~94% text accuracy vs ~70% with Imagen 4
 * Includes retry logic for handling 503 Service Unavailable errors
 */
/**
 * Result from illustration generation, includes raw image data for reference use
 */
interface IllustrationResult {
  publicUrl: string;
  imageBase64: string | null;
  mimeType: string;
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
  referenceImageBase64?: string,
  referenceImageMimeType?: string
): Promise<IllustrationResult> {
  const promptText = buildIllustrationPrompt(sceneDescription, animalType, style, pageText, characterSheets, settingIdentity);

  // Build multimodal contents: text prompt + optional reference image
  const contents: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];

  if (referenceImageBase64) {
    contents.push({ text: 'Here is the illustration from page 1 of this story. Use it as a VISUAL REFERENCE to maintain consistent character appearances, art style, color palette, and setting details across all pages. The characters must look identical to how they appear in this reference image.' });
    contents.push({ inlineData: { data: referenceImageBase64, mimeType: referenceImageMimeType || 'image/png' } });
  }

  contents.push({ text: promptText });

  console.log(`Generating illustration for page ${pageNumber} with Gemini 3 Pro Image${referenceImageBase64 ? ' (with page 1 reference)' : ''}...`);
  const startTime = Date.now();

  let lastError: unknown = null;

  // Retry loop for handling temporary 503 errors
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: {
          responseModalities: ['IMAGE'],
        },
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

      const buffer = Buffer.from(imageData, 'base64');
      const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';

      const filename = `stories/${storyId}/page-${pageNumber}-${uuid()}.${extension}`;
      const file = bucket.file(filename);

      await file.save(buffer, {
        contentType: mimeType,
        metadata: {
          cacheControl: 'public, max-age=31536000',
        },
      });

      const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
      console.log(`Uploaded illustration: ${publicUrl}`);

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
  return { publicUrl: `https://placehold.co/800x600/png?text=Page+${pageNumber}`, imageBase64: null, mimeType: 'image/png' };
}

/**
 * Generate all illustrations for a story
 * Strategy: Generate page 1 first as a visual reference, then generate
 * remaining pages in parallel with page 1's image as multimodal context.
 * This dramatically improves character and setting consistency across pages.
 */
export async function generateAllIllustrations(
  story: GeneratedStory,
  storyId: string,
  animalType: string,
  style: ArtStyle = 'watercolor'
): Promise<string[]> {
  console.log(`Generating ${story.pages.length} illustrations with Gemini 3 Pro Image (page 1 first for reference)...`);
  const startTime = Date.now();

  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const [firstPage, ...remainingPages] = sortedPages;

  // Step 1: Generate page 1 first to use as visual reference
  console.log('Step 2a: Generating page 1 as visual reference...');
  const firstResult = await generateIllustration(
    firstPage.sceneDescription,
    animalType,
    storyId,
    firstPage.pageNumber,
    style,
    firstPage.text,
    story.characterSheets,
    story.settingIdentity
  );

  const results: Map<number, string> = new Map();
  results.set(firstPage.pageNumber, firstResult.publicUrl);

  // Step 2: Generate remaining pages in parallel, passing page 1 as reference
  if (remainingPages.length > 0) {
    console.log(`Step 2b: Generating pages ${remainingPages.map(p => p.pageNumber).join(', ')} in parallel with page 1 reference...`);

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
        firstResult.imageBase64 || undefined,
        firstResult.mimeType
      )
    );

    const remainingResults = await Promise.all(remainingPromises);
    remainingPages.forEach((page, index) => {
      results.set(page.pageNumber, remainingResults[index].publicUrl);
    });
  }

  // Return URLs in page order
  const imageUrls = sortedPages.map((page) => results.get(page.pageNumber)!);

  const elapsed = Date.now() - startTime;
  console.log(`All ${story.pages.length} illustrations generated in ${elapsed}ms`);

  return imageUrls;
}
