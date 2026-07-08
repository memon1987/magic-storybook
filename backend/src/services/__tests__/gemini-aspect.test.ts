/**
 * FC-028 — Pin backend illustration aspect ratio (16:9 landscape).
 *
 * Path B (prompt-level): the installed `@google/genai` v0.7.0 has no
 * `imageConfig`/`aspectRatio` on `GenerateContentConfig`, so the 16:9 pin is a
 * shared prompt instruction appended to all four image-generation prompt
 * builders. These tests assert the pin is actually carried in the `contents`
 * sent to `generateContent` at EVERY image call site — page illustration,
 * character reference, cast reference, title page — plus a builder-level unit
 * test on each of the four prompt builders. If any call site drops the shared
 * instruction, a test here fails. See docs/plans/fc-028.md.
 *
 * Approach mirrors resume.test.ts: mock the Google SDKs at the boundary
 * (mock-before-import), but with a CAPTURING generateContent that records the
 * `contents` argument of every call so we can assert on the prompt text sent.
 * No real API calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs BEFORE all imports — gemini.ts reads env vars at module load.
vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';
});

import { ASPECT_RATIO_INSTRUCTION } from '../../prompts/aspect';
import { buildIllustrationPrompt } from '../../prompts/illustration';
import { buildTitlePagePrompt } from '../../prompts/titlePage';
import { buildCharacterReferencePrompt, buildCastReferencePrompt } from '../../prompts/characterReference';

// Capturing mock: every generateContent call pushes its args here so tests can
// inspect the `contents` (prompt text) actually sent to the model.
const captured: Array<{ model: string; contents: unknown; config: unknown }> = [];

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({
          save: async () => undefined,
          download: async () => [Buffer.from('')],
        }),
      };
    }
  },
}));
// Vision throws → scoreBakedText fails open → generateIllustration keeps its
// first (only) candidate without needing a real OCR pass.
vi.mock('@google-cloud/vision', () => ({
  ImageAnnotatorClient: class {
    async textDetection() {
      throw new Error('mock: vision disabled');
    }
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (args: { model: string; contents: unknown; config: unknown }) => {
        captured.push({ model: args.model, contents: args.contents, config: args.config });
        return {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: 'fake-base64', mimeType: 'image/png' } }],
              },
            },
          ],
        };
      },
    };
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
    HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
    HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
  },
  HarmBlockThreshold: {
    BLOCK_LOW_AND_ABOVE: 'BLOCK_LOW_AND_ABOVE',
    BLOCK_MEDIUM_AND_ABOVE: 'BLOCK_MEDIUM_AND_ABOVE',
    BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
    BLOCK_NONE: 'BLOCK_NONE',
    OFF: 'OFF',
  },
}));

// Import AFTER vi.mock so the mocked modules are wired in.
// eslint-disable-next-line import/first
import {
  generateIllustration,
  generateCharacterReference,
  generateCastReference,
  generateTitlePage,
} from '../gemini';

/**
 * Flatten the text of every text-part in a `contents` argument, whether it is
 * a string, a single part, or an array of {text}/{inlineData} parts. Returns
 * the concatenation of all text parts so we can assert the instruction is
 * present somewhere in the prompt.
 */
function contentsText(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  const arr = Array.isArray(contents) ? contents : [contents];
  return arr
    .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
    .join('\n');
}

/**
 * Assert that every captured image-generation call carries the shared 16:9
 * instruction in its prompt text AND still requests responseModalities: IMAGE.
 * `expectedCalls` guards against a call site silently not firing.
 */
function assertAllCallsPinned(expectedCalls: number) {
  expect(captured.length).toBe(expectedCalls);
  for (const call of captured) {
    expect(contentsText(call.contents)).toContain(ASPECT_RATIO_INSTRUCTION);
    expect((call.config as { responseModalities?: string[] }).responseModalities).toEqual(['IMAGE']);
  }
}

describe('FC-028 — 16:9 aspect-ratio pin at every image call site', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
  });

  it('page illustration (generateIllustration) sends the pin', async () => {
    await generateIllustration(
      'A rabbit hops through a meadow.',
      'rabbit',
      'story-1',
      1,
      'The rabbit hopped happily.',
      'watercolor',
      [{ name: 'Mira', description: 'a small rabbit' }],
      { name: 'meadow', description: 'a green meadow' },
      [],
      undefined,
      undefined,
      { verifyText: false }, // skip OCR verify loop — single generation
    );
    assertAllCallsPinned(1);
  });

  it('character reference (generateCharacterReference) sends the pin', async () => {
    await generateCharacterReference(
      { name: 'Mira', description: 'a small rabbit' },
      'story-2',
      'watercolor',
      0,
    );
    assertAllCallsPinned(1);
  });

  it('cast reference (generateCastReference) sends the pin', async () => {
    await generateCastReference(
      [
        { name: 'Mira', description: 'a small rabbit' },
        { name: 'Olu', description: 'a tall giraffe' },
      ],
      'story-3',
      'watercolor',
    );
    assertAllCallsPinned(1);
  });

  it('title page (generateTitlePage) sends the pin', async () => {
    await generateTitlePage(
      { text: 'Mira the Rabbit', sceneDescription: 'a rabbit on a cover' },
      'story-4',
      'watercolor',
      [],
    );
    assertAllCallsPinned(1);
  });
});

describe('FC-028 — prompt builders embed the shared instruction', () => {
  it('buildIllustrationPrompt (with page text) contains the instruction', () => {
    const p = buildIllustrationPrompt(
      'scene',
      'rabbit',
      'watercolor',
      'Some page text.',
    );
    expect(p).toContain(ASPECT_RATIO_INSTRUCTION);
  });

  it('buildIllustrationPrompt (no page text / no-text fallback) contains the instruction', () => {
    const p = buildIllustrationPrompt('scene', 'rabbit', 'watercolor');
    expect(p).toContain(ASPECT_RATIO_INSTRUCTION);
  });

  it('buildTitlePagePrompt contains the instruction', () => {
    const p = buildTitlePagePrompt('Title', 'cover scene', 'watercolor');
    expect(p).toContain(ASPECT_RATIO_INSTRUCTION);
  });

  it('buildCharacterReferencePrompt contains the instruction', () => {
    const p = buildCharacterReferencePrompt('Mira', 'a small rabbit', 'watercolor');
    expect(p).toContain(ASPECT_RATIO_INSTRUCTION);
  });

  it('buildCastReferencePrompt contains the instruction', () => {
    const p = buildCastReferencePrompt(
      [
        { name: 'Mira', description: 'a small rabbit' },
        { name: 'Olu', description: 'a tall giraffe' },
      ],
      'watercolor',
    );
    expect(p).toContain(ASPECT_RATIO_INSTRUCTION);
  });
});
