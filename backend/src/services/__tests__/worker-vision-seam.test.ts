/**
 * FC-041 — worker vision-moderation seam integration test.
 *
 * Mirrors worker-moderation-seam.test.ts, but exercises the IMAGE gate that
 * runs AFTER generateAllIllustrations and BEFORE the finalize batch. Drives the
 * real production `runStoryWorker` against a Firestore double, with:
 *   - generateStory + generateModerationText (text gate) mocked to PASS,
 *   - generateAllIllustrations mocked to return page URLs,
 *   - downloadRef mocked to return fake bytes (or null for a placeholder),
 *   - generateVisionModerationText mocked → steered per test.
 *
 * Asserts the load-bearing consequences:
 *   (a) an UNSAFE image verdict leaves the doc status:'failed',
 *       failureReason:'safety_blocked', with NO 'complete' and NO pages
 *       subcollection written (the gate runs before the finalize batch);
 *   (b) an all-safe run proceeds to status:'complete';
 *   (c) a placeholder page URL (downloadRef → null) is SKIPPED (no vision call
 *       for it) and does not block.
 *
 * All model + downloadRef calls are MOCKED — zero real API/image/GCS calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fakeFirestoreInstance, fakeDelete } = vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';

  const docs = new Map<string, Record<string, unknown>>();
  // Track pages-subcollection writes so we can assert a blocked story never
  // writes any page docs.
  const pageWrites = new Map<string, Record<string, unknown>>();
  const fakeDelete = { __delete: true } as const;

  function applyUpdate(id: string, data: Record<string, unknown>): void {
    const current = docs.get(id) ?? {};
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && (v as { __delete?: boolean }).__delete) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
    docs.set(id, next);
  }

  interface TxLike {
    get: (ref: { id: string }) => Promise<{ exists: boolean; ref: { id: string }; data: () => Record<string, unknown> | undefined }>;
    update: (ref: { id: string }, data: Record<string, unknown>) => void;
  }

  const fakeFirestoreInstance = {
    setDoc: (id: string, data: Record<string, unknown>) => docs.set(id, { ...data }),
    getDoc: (id: string) => docs.get(id),
    pageWriteCount: () => pageWrites.size,
    reset: () => {
      docs.clear();
      pageWrites.clear();
    },

    collection: (_name: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: docs.has(id), ref: { id }, data: () => docs.get(id) }),
        update: async (data: Record<string, unknown>) => applyUpdate(id, data),
        collection: (_sub: string) => ({
          doc: (subId?: string) => ({
            id: subId ?? 'auto-id',
            set: async (data: Record<string, unknown>) => {
              pageWrites.set(`${id}/${subId ?? 'auto-id'}`, data);
            },
          }),
        }),
      }),
      where: () => {
        const q: { where: () => unknown; limit: () => unknown; get: () => Promise<{ docs: never[]; size: number }> } = {
          where: () => q,
          limit: () => q,
          get: async () => ({ docs: [], size: 0 }),
        };
        return q;
      },
    }),

    runTransaction: async <T,>(fn: (tx: TxLike) => Promise<T>): Promise<T> => {
      const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
      const tx: TxLike = {
        get: async (ref) => ({ exists: docs.has(ref.id), ref, data: () => docs.get(ref.id) }),
        update: (ref, data) => writes.push({ id: ref.id, data }),
      };
      const result = await fn(tx);
      for (const w of writes) applyUpdate(w.id, w.data);
      return result;
    },

    batch: () => {
      const ops: Array<{ id: string; data: Record<string, unknown>; op: 'update' | 'set'; sub?: string }> = [];
      return {
        update: (ref: { id: string }, data: Record<string, unknown>) => ops.push({ id: ref.id, data, op: 'update' }),
        set: (ref: { id: string }, data: Record<string, unknown>) => ops.push({ id: ref.id, data, op: 'set' }),
        commit: async () => {
          for (const op of ops) {
            if (op.op === 'set') {
              // page docs land here in the real worker; track them
              pageWrites.set(`${op.id}`, op.data);
            } else {
              applyUpdate(op.id, op.data);
            }
          }
        },
      };
    },
  };

  return { fakeFirestoreInstance, fakeDelete };
});

vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    constructor() {
      return fakeFirestoreInstance;
    }
  },
  FieldValue: {
    delete: () => fakeDelete,
    serverTimestamp: () => ({ __serverTimestamp: true }),
    increment: (n: number) => ({ __increment: n }),
  },
  FieldPath: class {
    constructor(..._parts: string[]) {}
  },
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms, __ts: true }),
  },
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return { file: () => ({ save: async () => undefined, download: async () => [Buffer.from('')] }) };
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

// Mock gemini.ts at the module boundary. generateStory returns a fixed story;
// the TEXT gate (generateModerationText) is steered to PASS; the VISION gate
// (generateVisionModerationText) is steered per-test; generateAllIllustrations
// returns page URLs.
const geminiMock = vi.hoisted(() => ({
  generateStory: vi.fn(),
  generateModerationText: vi.fn(),
  generateVisionModerationText: vi.fn(),
  generateAllIllustrations: vi.fn(),
}));

vi.mock('../gemini', () => ({
  generateStory: geminiMock.generateStory,
  generateModerationText: geminiMock.generateModerationText,
  generateVisionModerationText: geminiMock.generateVisionModerationText,
  generateAllIllustrations: geminiMock.generateAllIllustrations,
}));

// Mock gcsDownload so no real GCS fetch happens; steered per-test.
// isOurBucketUrl mirrors the real prefix check (our-bucket GCS URL vs. a
// non-bucket placeholder) so the worker gate can disambiguate the two
// downloadRef→null cases (FC-041 review HIGH).
const downloadMock = vi.hoisted(() => ({
  downloadRef: vi.fn(),
  isOurBucketUrl: vi.fn((url: string) => url.startsWith('https://storage.googleapis.com/test-bucket/')),
}));
vi.mock('../gcsDownload', () => ({
  downloadRef: downloadMock.downloadRef,
  isOurBucketUrl: downloadMock.isOurBucketUrl,
}));

// Import AFTER mocks.
// eslint-disable-next-line import/first
import { runStoryWorker } from '../worker';
// eslint-disable-next-line import/first
import { GeneratedStory } from '../types';

function fixtureStory(): GeneratedStory {
  return {
    title: 'The Adventure',
    characterSheets: [{ name: 'Emma', description: 'a brave girl' }],
    settingIdentity: { name: 'forest', description: 'a green forest' },
    pages: [
      { pageNumber: 1, text: 'Page one text.', sceneDescription: 's1' },
      { pageNumber: 2, text: 'Page two text.', sceneDescription: 's2' },
    ],
    titlePage: { text: 'Cover', sceneDescription: 'cover' },
  };
}

function seedQueuedDoc(id: string) {
  fakeFirestoreInstance.setDoc(id, {
    userId: 'user-1',
    status: 'queued',
    childName: 'Emma',
    favoriteAnimal: 'a bunny named Hop',
    setting: 'a forest',
    moral: 'kindness',
    length: 'short',
    artStyle: 'watercolor',
    attempt: 0,
  });
}

const GCS = 'https://storage.googleapis.com/test-bucket';

describe('FC-041 worker vision-moderation seam', () => {
  beforeEach(() => {
    fakeFirestoreInstance.reset();
    geminiMock.generateStory.mockReset();
    geminiMock.generateModerationText.mockReset();
    geminiMock.generateVisionModerationText.mockReset();
    geminiMock.generateAllIllustrations.mockReset();
    downloadMock.downloadRef.mockReset();

    geminiMock.generateStory.mockResolvedValue(fixtureStory());
    // TEXT gate passes.
    geminiMock.generateModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'safe', category: 'none', reason: 'ok' }),
    );
    // Illustrations resolve with two real GCS page URLs + a GCS title URL.
    geminiMock.generateAllIllustrations.mockResolvedValue({
      characterReferenceUrls: {},
      castReferenceUrl: null,
      titlePageImageUrl: `${GCS}/title.png`,
      pageUrls: [`${GCS}/p1.png`, `${GCS}/p2.png`],
    });
    // Every real GCS URL rehydrates to fake bytes by default.
    downloadMock.downloadRef.mockResolvedValue({ data: 'ZmFrZQ==', mimeType: 'image/png' });
  });

  it('(a) UNSAFE image verdict → doc failed:safety_blocked, NO complete, NO pages written', async () => {
    seedQueuedDoc('story-img-unsafe');
    // Title is safe, page-1 is unsafe. (title classified first, then page-1.)
    geminiMock.generateVisionModerationText
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'safe', category: 'none' }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'unsafe', category: 'violence' }));

    await expect(runStoryWorker('story-img-unsafe')).rejects.toBeTruthy();

    const doc = fakeFirestoreInstance.getDoc('story-img-unsafe')!;
    expect(doc.status).toBe('failed');
    expect(doc.failureReason).toBe('safety_blocked');
    // The finalize batch never ran → status is never 'complete' and no page
    // docs were written.
    expect(doc.status).not.toBe('complete');
    expect(fakeFirestoreInstance.pageWriteCount()).toBe(0);
    // page-2 short-circuited (title + page-1 = 2 vision calls).
    expect(geminiMock.generateVisionModerationText).toHaveBeenCalledTimes(2);
  });

  it('(b) all-safe images → proceeds to status:complete, pages written', async () => {
    seedQueuedDoc('story-img-safe');
    geminiMock.generateVisionModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'safe', category: 'none' }),
    );

    await runStoryWorker('story-img-safe');

    const doc = fakeFirestoreInstance.getDoc('story-img-safe')!;
    expect(doc.status).toBe('complete');
    // title + 2 pages = 3 vision calls, all safe.
    expect(geminiMock.generateVisionModerationText).toHaveBeenCalledTimes(3);
    // pages subcollection written (2 pages).
    expect(fakeFirestoreInstance.pageWriteCount()).toBe(2);
  });

  it('(c) placeholder page URL (downloadRef → null) is SKIPPED (no vision call), does not block', async () => {
    seedQueuedDoc('story-img-placeholder');
    // title + p1 rehydrate; p2 is a placeholder (downloadRef returns null).
    geminiMock.generateAllIllustrations.mockResolvedValue({
      characterReferenceUrls: {},
      castReferenceUrl: null,
      titlePageImageUrl: `${GCS}/title.png`,
      pageUrls: [`${GCS}/p1.png`, 'https://placehold.co/1024x1024/png'],
    });
    downloadMock.downloadRef.mockImplementation(async (url: string) =>
      url.startsWith(GCS) ? { data: 'ZmFrZQ==', mimeType: 'image/png' } : null,
    );
    geminiMock.generateVisionModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'safe', category: 'none' }),
    );

    await runStoryWorker('story-img-placeholder');

    const doc = fakeFirestoreInstance.getDoc('story-img-placeholder')!;
    expect(doc.status).toBe('complete');
    // Only title + p1 were moderated; the placeholder p2 was skipped.
    expect(geminiMock.generateVisionModerationText).toHaveBeenCalledTimes(2);
  });

  it('(HIGH) our-bucket page whose downloadRef returns null (transient download failure) → FAIL CLOSED, doc failed:generation_error (RESUMABLE, not safety_blocked), NO complete, NO pages', async () => {
    seedQueuedDoc('story-img-dlfail');
    // title + p1 are our-bucket; p1 fails to download (returns null) even
    // though it IS our bucket → must fail closed as an infra error, NOT skip.
    geminiMock.generateAllIllustrations.mockResolvedValue({
      characterReferenceUrls: {},
      castReferenceUrl: null,
      titlePageImageUrl: `${GCS}/title.png`,
      pageUrls: [`${GCS}/p1.png`, `${GCS}/p2.png`],
    });
    downloadMock.downloadRef.mockImplementation(async (url: string) =>
      url.endsWith('/p1.png') ? null : { data: 'ZmFrZQ==', mimeType: 'image/png' },
    );
    geminiMock.generateVisionModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'safe', category: 'none' }),
    );

    await expect(runStoryWorker('story-img-dlfail')).rejects.toBeTruthy();

    const doc = fakeFirestoreInstance.getDoc('story-img-dlfail')!;
    expect(doc.status).toBe('failed');
    // CRITICAL: a download failure is INFRA, not content — must be the
    // RESUMABLE generation_error, NOT safety_blocked (which FC-031 makes
    // non-resumable + "create a new story", falsely blaming the content).
    expect(doc.failureReason).toBe('generation_error');
    expect(doc.status).not.toBe('complete');
    expect(fakeFirestoreInstance.pageWriteCount()).toBe(0);
    // The download loop rehydrates ALL images before any classify call; p1's
    // null (our-bucket) throws mid-loop, so moderateStoryImages never runs →
    // zero classifier calls.
    expect(geminiMock.generateVisionModerationText).not.toHaveBeenCalled();
  });

  it('vision classifier REJECTION on an image → fail-closed: doc failed:safety_blocked, no complete', async () => {
    seedQueuedDoc('story-img-error');
    geminiMock.generateVisionModerationText.mockRejectedValue(new Error('gemini 503 UNAVAILABLE'));

    await expect(runStoryWorker('story-img-error')).rejects.toBeTruthy();

    const doc = fakeFirestoreInstance.getDoc('story-img-error')!;
    expect(doc.status).toBe('failed');
    expect(doc.failureReason).toBe('safety_blocked');
    expect(fakeFirestoreInstance.pageWriteCount()).toBe(0);
  });
});
