/**
 * FC-017 Phase 2 — resume-logic tests.
 *
 * Required by `docs/plans/fc-017.md` §211 and re-stated as Stage 5 of
 * `docs/plans/fc-025.md`. Covers the resume-skip semantics observable
 * via the JobStateWriter contract — when state contains a prior-run
 * artifact, the writer is NOT called for it again.
 *
 * Approach: mock the Google SDKs at the boundary so generation calls
 * succeed with fake image bytes, then drive `generateAllIllustrations`
 * with various JobState shapes and assert on what the recording
 * JobStateWriter captured. WRITER state IS the user-facing contract —
 * if writer.saveX is called, the Firestore doc gets that update.
 *
 * Out of scope here (deferred to Stage 6 manual integration test):
 *   - The transactional claimLock semantics under concurrent claims
 *     (needs Firestore emulator).
 *   - The B-4 nested-serverTimestamp fix actually writes a real
 *     Timestamp (needs Firestore emulator).
 *   - The B-2 placeholder-URL skip (needs intra-module mock to force
 *     generateIllustration's placeholder branch — ESM mock limitation;
 *     covered by code-review + smoke test post-merge).
 *   - The B-1 same-process dedup Map (needs to spy on runStoryWorker's
 *     entry point; covered manually in Stage 6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs BEFORE all imports (including transitive ones). Required
// because gcsDownload.ts and gemini.ts read env vars at module-load time —
// without hoisting, the env-var assignment would run after the import-time
// throw fired.
vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';
});

import { emptyJobState, JobState, JobStateWriter } from '../jobState';
import { GeneratedStory, PageGenerationRecord } from '../types';

// Mock the Google SDKs so importing gemini.ts works in test env.
// generateContent returns a valid image payload on every call — chain succeeds.
// Vision throws → scoreBakedText fails-open → every page "passes OCR".
// Storage bucket save/download are no-ops returning empty buffers.
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
      generateContent: async () => ({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: 'fake-base64', mimeType: 'image/png' } }],
            },
          },
        ],
      }),
    };
  },
}));

// Import AFTER vi.mock so the mocked modules are wired in.
// eslint-disable-next-line import/first
import { generateAllIllustrations } from '../gemini';

function makeStory(pageCount: number, chars: string[]): GeneratedStory {
  return {
    title: 'Test Story',
    characterSheets: chars.map((name) => ({ name, description: `${name} is a thing.` })),
    settingIdentity: { name: 'forest', description: 'a forest' },
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      text: `Page ${i + 1} text.`,
      sceneDescription: `Page ${i + 1} scene.`,
    })),
    titlePage: { text: 'Cover', sceneDescription: 'cover scene' },
  };
}

class RecordingWriter implements JobStateWriter {
  storyText?: GeneratedStory;
  charRefs: Record<string, string> = {};
  castRef: string | null | undefined; // undefined = not called; null = explicitly persisted as null
  titleUrl: string | null | undefined;
  pages: Record<number, PageGenerationRecord> = {};
  progressCalls: Array<{ phase: string; completed: number; total: number; message: string }> = [];

  async saveStoryText(s: GeneratedStory) { this.storyText = s; }
  async saveCharacterReference(name: string, url: string) { this.charRefs[name] = url; }
  async saveCastReference(url: string | null) { this.castRef = url; }
  async saveTitlePage(url: string | null) { this.titleUrl = url; }
  async savePage(n: number, r: PageGenerationRecord) { this.pages[n] = r; }
  async saveProgress(phase: string, completed: number, total: number, message: string) {
    this.progressCalls.push({ phase, completed, total, message });
  }
}

describe('FC-017 Phase 2 — resume-aware generateAllIllustrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initial run (no prior state): writer records every artifact', async () => {
    const story = makeStory(4, ['Mira', 'Olu']);
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-1', 'rabbit', 'watercolor', 'Mira', {
      state: emptyJobState('story-1'),
      writer,
    });
    expect(Object.keys(writer.charRefs).sort()).toEqual(['Mira', 'Olu']);
    expect(writer.castRef).toBeTruthy();
    expect(writer.titleUrl).toBeTruthy();
    expect(Object.keys(writer.pages).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('resume with all char-refs already done: writer does NOT re-save them', async () => {
    const story = makeStory(4, ['Mira', 'Olu']);
    const state: JobState = {
      ...emptyJobState('story-2'),
      characterReferenceUrls: {
        Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png',
        Olu: 'https://storage.googleapis.com/test-bucket/character-refs/Olu.png',
      },
    };
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-2', 'rabbit', 'watercolor', 'Mira', { state, writer });
    // Already-done chars were skipped → writer never recorded them.
    expect(writer.charRefs.Mira).toBeUndefined();
    expect(writer.charRefs.Olu).toBeUndefined();
  });

  it('resume with cast already done: writer does NOT re-save cast', async () => {
    const story = makeStory(3, ['Mira', 'Olu']);
    const state: JobState = {
      ...emptyJobState('story-3'),
      characterReferenceUrls: {
        Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png',
        Olu: 'https://storage.googleapis.com/test-bucket/character-refs/Olu.png',
      },
      castReferenceUrl: 'https://storage.googleapis.com/test-bucket/character-refs/cast.png',
    };
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-3', 'rabbit', 'watercolor', 'Mira', { state, writer });
    expect(writer.castRef).toBeUndefined();
  });

  it('FC-025 B-6: castAttempted=true + castReferenceUrl=undefined: SKIP (do NOT retry)', async () => {
    const story = makeStory(3, ['Mira', 'Olu']);
    const state: JobState = {
      ...emptyJobState('story-b6-cast'),
      characterReferenceUrls: {
        Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png',
        Olu: 'https://storage.googleapis.com/test-bucket/character-refs/Olu.png',
      },
      castReferenceUrl: undefined,
      castAttempted: true, // prior run attempted and failed
    };
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-b6-cast', 'rabbit', 'watercolor', 'Mira', { state, writer });
    // The critical fix: castAttempted=true is treated as "already done",
    // not as "never tried". Without the fix, writer.castRef would be set
    // to either the new URL or null (i.e. the cast was re-generated).
    expect(writer.castRef).toBeUndefined();
  });

  it('FC-025 B-6: titleAttempted=true + titlePageImageUrl=undefined: SKIP (do NOT retry)', async () => {
    const story = makeStory(3, ['Mira']);
    const state: JobState = {
      ...emptyJobState('story-b6-title'),
      characterReferenceUrls: {
        Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png',
      },
      titlePageImageUrl: undefined,
      titleAttempted: true, // prior run attempted and failed
    };
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-b6-title', 'rabbit', 'watercolor', 'Mira', { state, writer });
    expect(writer.titleUrl).toBeUndefined();
  });

  it('resume with all anchor pages already done: only parallel pages re-saved', async () => {
    const story = makeStory(5, ['Mira']);
    const state: JobState = {
      ...emptyJobState('story-4'),
      characterReferenceUrls: { Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png' },
      titlePageImageUrl: 'https://storage.googleapis.com/test-bucket/title.png',
      titleAttempted: true,
      pageUrls: {
        '1': { url: 'https://storage.googleapis.com/test-bucket/page-1.png', ocrPassed: true, attempts: 1 },
        '2': { url: 'https://storage.googleapis.com/test-bucket/page-2.png', ocrPassed: true, attempts: 1 },
      },
    };
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-4', 'rabbit', 'watercolor', 'Mira', { state, writer });
    // Anchor pages skipped → writer doesn't re-record 1 or 2.
    expect(writer.pages[1]).toBeUndefined();
    expect(writer.pages[2]).toBeUndefined();
    // Parallel pages 3, 4, 5 generated → writer recorded each.
    expect(writer.pages[3]).toBeDefined();
    expect(writer.pages[4]).toBeDefined();
    expect(writer.pages[5]).toBeDefined();
  });

  it('resume with all pages done: writer records ZERO pages + final result includes persisted URLs', async () => {
    const story = makeStory(3, ['Mira']);
    const state: JobState = {
      ...emptyJobState('story-5'),
      characterReferenceUrls: { Mira: 'https://storage.googleapis.com/test-bucket/character-refs/Mira.png' },
      titlePageImageUrl: 'https://storage.googleapis.com/test-bucket/title.png',
      titleAttempted: true,
      pageUrls: {
        '1': { url: 'https://storage.googleapis.com/test-bucket/page-1.png', ocrPassed: true, attempts: 1 },
        '2': { url: 'https://storage.googleapis.com/test-bucket/page-2.png', ocrPassed: true, attempts: 1 },
        '3': { url: 'https://storage.googleapis.com/test-bucket/page-3.png', ocrPassed: true, attempts: 1 },
      },
    };
    const writer = new RecordingWriter();
    const result = await generateAllIllustrations(story, 'story-5', 'rabbit', 'watercolor', 'Mira', { state, writer });
    expect(Object.keys(writer.pages)).toEqual([]);
    expect(result.pageUrls).toEqual([
      'https://storage.googleapis.com/test-bucket/page-1.png',
      'https://storage.googleapis.com/test-bucket/page-2.png',
      'https://storage.googleapis.com/test-bucket/page-3.png',
    ]);
  });

  it('FC-025 H-8: per-page saveProgress fires INSIDE the parallel batch (not just once before)', async () => {
    const story = makeStory(4, ['Mira']); // K=2 anchor + 2 parallel
    const writer = new RecordingWriter();
    await generateAllIllustrations(story, 'story-h8', 'rabbit', 'watercolor', 'Mira', {
      state: emptyJobState('story-h8'),
      writer,
    });
    const parallel = writer.progressCalls.filter((p) => p.phase === 'parallel-pages');
    // Initial saveProgress + 1 per parallel page (2) = 3 minimum.
    expect(parallel.length).toBeGreaterThanOrEqual(3);
    const last = parallel[parallel.length - 1];
    expect(last.completed).toBe(2);
    expect(last.total).toBe(2);
  });
});
