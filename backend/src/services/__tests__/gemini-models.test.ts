/**
 * FC-045 — Gemini model refresh: call-site tests.
 *
 * 1. Every image call site stores the FINAL image, not an interim thought
 *    draft (and honors the final part's mime type).
 * 2. Safety settings: all seven call sites send the four categories at
 *    BLOCK_LOW_AND_ABOVE.
 * 3. Model routing policy: the four image calls share one model ID, no text
 *    call uses it, and no ID is a preview / experimental / -latest alias
 *    except the explicit allow-list (FC-047). Literal IDs are otherwise NOT
 *    asserted — that would only lock in today's constants.
 *
 * Mirrors the mock-before-import pattern in gemini-aspect.test.ts, with a
 * Storage mock that captures every save and a generateContent mock that
 * branches on IMAGE modality. No real API calls. See docs/plans/fc-045.md §3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs BEFORE all imports — gemini.ts reads env vars at module load.
// Fixtures live here too so the hoisted vi.mock factories can reference them.
const { b64, MODERATION_SENTINEL, STORY_JSON, VERDICT_JSON, generateCalls, saves } = vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';
  return {
    b64: (s: string) => Buffer.from(s).toString('base64'),
    // Text-call discriminator: vision moderation sends an ARRAY of contents;
    // text moderation sends a string containing this sentinel (the test passes
    // it in); any other string is the story prompt from buildStoryPrompt.
    MODERATION_SENTINEL: '__FC045_MODERATION_PROMPT__',
    STORY_JSON: JSON.stringify({
      title: 'Mira and the Meadow',
      pages: [{ pageNumber: 1, text: 'Mira hopped.', sceneDescription: 'A rabbit in a meadow.' }],
      characterSheets: [],
      settingIdentity: { name: 'meadow', description: 'a green meadow' },
    }),
    VERDICT_JSON: '{"verdict":"safe","category":"none","reason":"ok"}',
    generateCalls: [] as Array<{ model: string; contents: unknown; config: unknown }>,
    saves: [] as Array<{ name: string; buffer: Buffer; opts: unknown }>,
  };
});

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: (name: string) => ({
          save: async (buffer: Buffer, opts: unknown) => {
            saves.push({ name, buffer, opts });
          },
          download: async () => [Buffer.from('')],
        }),
      };
    }
  },
}));
// Vision throws → scoreBakedText fails open (OCR is not under test here).
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
      generateContent: async (args: { model: string; contents: unknown; config?: { responseModalities?: string[] } }) => {
        generateCalls.push({ model: args.model, contents: args.contents, config: args.config });
        if (args.config?.responseModalities?.includes('IMAGE')) {
          // Interim thought image + thought text BEFORE the final image; the
          // final image has a different mime type than the draft.
          return {
            candidates: [
              {
                content: {
                  parts: [
                    { inlineData: { data: b64('DRAFT'), mimeType: 'image/png' }, thought: true },
                    { text: 'planning', thought: true },
                    { inlineData: { data: b64('FINAL'), mimeType: 'image/jpeg' } },
                  ],
                },
              },
            ],
          };
        }
        const isStoryPrompt = typeof args.contents === 'string' && !args.contents.includes(MODERATION_SENTINEL);
        return { text: isStoryPrompt ? STORY_JSON : VERDICT_JSON };
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
  generateStory,
  generateModerationText,
  generateVisionModerationText,
  generateIllustration,
  generateCharacterReference,
  generateCastReference,
  generateTitlePage,
} from '../gemini';

const callIllustration = () =>
  generateIllustration(
    'A rabbit hops through a meadow.', 'rabbit', 'story-p', 1, 'The rabbit hopped happily.', 'watercolor',
    [{ name: 'Mira', description: 'a small rabbit' }], { name: 'meadow', description: 'a green meadow' },
    [], undefined, undefined, { verifyText: false },
  );
const callCharRef = () =>
  generateCharacterReference({ name: 'Mira', description: 'a small rabbit' }, 'story-c', 'watercolor', 0);
const callCastRef = () =>
  generateCastReference(
    [{ name: 'Mira', description: 'a small rabbit' }, { name: 'Olu', description: 'a tall giraffe' }],
    'story-k', 'watercolor',
  );
const callTitle = () =>
  generateTitlePage({ text: 'Mira the Rabbit', sceneDescription: 'a rabbit on a cover' }, 'story-t', 'watercolor', []);

/** Asserts exactly one upload happened and it is the FINAL image as a .jpg. */
function expectFinalStored() {
  expect(saves.length).toBe(1);
  const save = saves[0];
  expect(save.buffer.toString()).toBe('FINAL');
  expect(save.name.endsWith('.jpg')).toBe(true);
  expect((save.opts as { contentType?: string }).contentType).toBe('image/jpeg');
}

beforeEach(() => {
  generateCalls.length = 0;
  saves.length = 0;
});

describe('FC-045 — every image call site stores the final image, never a thought draft', () => {
  it('generateIllustration stores + returns FINAL', async () => {
    const r = await callIllustration();
    expectFinalStored();
    expect(r.imageBase64).toBe(b64('FINAL'));
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('generateCharacterReference stores + returns FINAL', async () => {
    const r = await callCharRef();
    expectFinalStored();
    expect(r.imageBase64).toBe(b64('FINAL'));
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('generateCastReference stores + returns FINAL', async () => {
    const r = await callCastRef();
    expectFinalStored();
    expect(r.imageBase64).toBe(b64('FINAL'));
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('generateTitlePage stores FINAL', async () => {
    const url = await callTitle();
    expectFinalStored();
    expect(url).toMatch(/\.jpg$/);
  });
});

/**
 * Drives all seven generateContent call sites. Returns the captured calls for
 * the three text sites and the four image sites separately.
 */
async function driveAllCallSites() {
  generateCalls.length = 0;
  const story = await generateStory({ childName: 'Mira', setting: 'forest', moral: 'kindness', length: 'short' }, 'story-s');
  expect(story.title).toBe('Mira and the Meadow');
  expect(await generateModerationText(`${MODERATION_SENTINEL} classify this story`, 'story-m')).toBe(VERDICT_JSON);
  expect(
    await generateVisionModerationText('classify this page', { data: b64('FINAL'), mimeType: 'image/jpeg' }, 'story-v'),
  ).toBe(VERDICT_JSON);
  const textCalls = generateCalls.splice(0);
  expect(textCalls).toHaveLength(3);

  await callIllustration();
  await callCharRef();
  await callCastRef();
  await callTitle();
  const imageCalls = generateCalls.splice(0);
  expect(imageCalls).toHaveLength(4);
  return { textCalls, imageCalls };
}

describe('FC-045 — safety settings are sent on every call', () => {
  it('all seven call sites send exactly the four categories at BLOCK_LOW_AND_ABOVE', async () => {
    const { textCalls, imageCalls } = await driveAllCallSites();
    const expected = [
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    ];
    for (const call of [...textCalls, ...imageCalls]) {
      const settings = (call.config as { safetySettings?: Array<{ category: string; threshold: string }> } | undefined)
        ?.safetySettings;
      expect(Array.isArray(settings)).toBe(true);
      expect(settings!.map((s) => s.category).sort()).toEqual(expected);
      for (const s of settings!) expect(s.threshold).toBe('BLOCK_LOW_AND_ABOVE');
    }
  });
});

// FC-045 / FC-047: TEXT_MODEL deliberately stays on this preview ID because it
// also runs both fail-closed safety classifiers; moving it needs the labelled
// safety evaluation in FC-047. Remove this entry when FC-047 lands. Do not add
// new entries without a plan.
const ALLOWED_PREVIEW_IDS = ['gemini-3-flash-preview'];
const PREVIEW_ALIAS_PATTERN = /(^|-)(preview|exp|experimental|latest)(-|$)/i;

describe('FC-045 — model routing policy', () => {
  it('image calls share one ID, no text call uses it, and no new preview/exp/latest ID is pinned', async () => {
    const { textCalls, imageCalls } = await driveAllCallSites();
    const textModels = textCalls.map((c) => c.model);
    const imageModels = imageCalls.map((c) => c.model);

    // NOTE: the three text calls are deliberately NOT required to share one ID
    // — FC-047 may split the moderation model from the story model.
    expect(new Set(imageModels).size).toBe(1);
    const imageModel = imageModels[0];
    for (const m of textModels) expect(m).not.toBe(imageModel);

    for (const model of [...textModels, ...imageModels]) {
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
      if (ALLOWED_PREVIEW_IDS.includes(model)) continue;
      expect(model).not.toMatch(PREVIEW_ALIAS_PATTERN);
    }
  });
});
