/**
 * FC-037 review LOW-8 — worker Phase-1 moderation seam integration test.
 *
 * Both adversarial reviews flagged that no test exercised the actual
 * `runStoryWorker` → `moderateStoryText` → `saveStoryText` ordering: unit
 * tests covered `moderateStoryText` in isolation and the resume path in
 * isolation, but nothing proved the WORKER blocks a story when moderation
 * fails. This drives the real production `runStoryWorker` against a Firestore
 * double, with `generateStory` + the moderation classifier mocked, and
 * asserts the two load-bearing consequences of an unsafe verdict:
 *
 *   1. The doc ends `status:'failed'` with `failureReason:'safety_blocked'`
 *      (the ModerationBlockedError message → sanitizeFailureReason mapping).
 *   2. NO `storyText` is ever persisted — the gate runs BEFORE
 *      writer.saveStoryText, so the resume path (which skips story-text when
 *      state.storyText is present) can never resume a blocked story.
 *
 * Contrast case: a SAFE verdict lets the pipeline proceed (storyText is
 * persisted / the worker gets past Phase 1). All model calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before ALL imports (including transitive gemini.ts /
// worker.ts module-load side effects that read env + construct clients).
const { fakeFirestoreInstance, fakeDelete } = vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';

  const docs = new Map<string, Record<string, unknown>>();
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
    reset: () => docs.clear(),

    collection: (_name: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: docs.has(id), ref: { id }, data: () => docs.get(id) }),
        update: async (data: Record<string, unknown>) => applyUpdate(id, data),
        collection: () => ({
          doc: (subId?: string) => ({ id: subId ?? 'auto-id', set: async () => undefined }),
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
      const ops: Array<{ id: string; data: Record<string, unknown>; op: 'update' | 'set' }> = [];
      return {
        update: (ref: { id: string }, data: Record<string, unknown>) => ops.push({ id: ref.id, data, op: 'update' }),
        set: (ref: { id: string }, data: Record<string, unknown>) => ops.push({ id: ref.id, data, op: 'set' }),
        commit: async () => {
          for (const op of ops) {
            if (op.op === 'set') docs.set(op.id, { ...op.data });
            else applyUpdate(op.id, op.data);
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

// Mock gemini.ts at the module boundary: generateStory returns a fixed story,
// generateModerationText is the classifier we steer per-test, and
// generateAllIllustrations is a no-op so a SAFE story doesn't drag in the
// image pipeline (out of scope for this seam test).
const geminiMock = vi.hoisted(() => ({
  generateStory: vi.fn(),
  generateModerationText: vi.fn(),
  generateAllIllustrations: vi.fn(),
}));

vi.mock('../gemini', () => ({
  generateStory: geminiMock.generateStory,
  generateModerationText: geminiMock.generateModerationText,
  generateAllIllustrations: geminiMock.generateAllIllustrations,
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

describe('FC-037 worker Phase-1 moderation seam', () => {
  beforeEach(() => {
    fakeFirestoreInstance.reset();
    geminiMock.generateStory.mockReset();
    geminiMock.generateModerationText.mockReset();
    geminiMock.generateAllIllustrations.mockReset();
    geminiMock.generateStory.mockResolvedValue(fixtureStory());
    // If the pipeline proceeds past moderation, illustrations resolve trivially.
    geminiMock.generateAllIllustrations.mockResolvedValue({
      characterReferenceUrls: {},
      castReferenceUrl: null,
      titlePageImageUrl: null,
      pageUrls: ['u1', 'u2'],
    });
  });

  it('UNSAFE verdict → doc failed:safety_blocked and NO storyText persisted', async () => {
    seedQueuedDoc('story-unsafe');
    // Classifier returns an explicit unsafe verdict.
    geminiMock.generateModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'unsafe', category: 'violence', reason: 'x' }),
    );

    await expect(runStoryWorker('story-unsafe')).rejects.toBeTruthy();

    const doc = fakeFirestoreInstance.getDoc('story-unsafe')!;
    expect(doc.status).toBe('failed');
    expect(doc.failureReason).toBe('safety_blocked');
    // The gate runs BEFORE saveStoryText → storyText must never be persisted.
    expect(doc.storyText).toBeUndefined();
    // Illustrations must never have been attempted for a blocked story.
    expect(geminiMock.generateAllIllustrations).not.toHaveBeenCalled();
  });

  it('malformed classifier output (fail-closed) → also failed:safety_blocked, no storyText', async () => {
    seedQueuedDoc('story-malformed');
    geminiMock.generateModerationText.mockResolvedValue('I think this is fine!');

    await expect(runStoryWorker('story-malformed')).rejects.toBeTruthy();

    const doc = fakeFirestoreInstance.getDoc('story-malformed')!;
    expect(doc.status).toBe('failed');
    expect(doc.failureReason).toBe('safety_blocked');
    expect(doc.storyText).toBeUndefined();
    expect(geminiMock.generateAllIllustrations).not.toHaveBeenCalled();
  });

  it('SAFE verdict → moderation passes, storyText persisted, pipeline proceeds', async () => {
    seedQueuedDoc('story-safe');
    geminiMock.generateModerationText.mockResolvedValue(
      JSON.stringify({ verdict: 'safe', category: 'none', reason: 'ok' }),
    );

    await runStoryWorker('story-safe');

    // moderation was called exactly once with the classifier wrapper
    expect(geminiMock.generateModerationText).toHaveBeenCalledTimes(1);
    // pipeline proceeded past Phase 1
    expect(geminiMock.generateAllIllustrations).toHaveBeenCalledTimes(1);
    const doc = fakeFirestoreInstance.getDoc('story-safe')!;
    // terminal success clears storyText (batch delete) but status is complete
    expect(doc.status).toBe('complete');
  });
});
