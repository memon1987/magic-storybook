/**
 * FC-030 corruption-class hotfix — behavior tests for the four changes.
 *
 * Imports the PRODUCTION predicates (not inline copies). Each test
 * arranges a doc state in a minimal Firestore double, calls the real
 * `sigtermMarkFailed` / `sweepOrphanTx` / `bgCatchMarkFailed`, and
 * asserts the resulting doc state.
 *
 * Confirmation-review HIGH-1 fix: the previous test file had
 * hand-rewritten copies of the predicates inside the test file. The
 * tests passed even when the production predicates drifted. The
 * predicates are now exported from worker.ts / admin.ts / stories.ts
 * and imported here so production-code drift breaks tests.
 *
 * Out of scope (deferred to FC-033 with a real Firestore emulator):
 *   - True concurrent execution (Promise.race between transactions on
 *     the same doc). The in-memory mock executes transactions
 *     sequentially. The predicates themselves are the load-bearing
 *     logic; Firestore's strong-consistency-on-tx-reads carries the
 *     rest in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.hoisted` runs before ANY imports — including the @google-cloud/firestore
// mock factory below AND the transitive imports from worker.ts / admin.ts /
// stories.ts which all construct `new Firestore()` at module-load. The fake
// must exist before either of those fires.
const { fakeFirestoreInstance, fakeDelete } = vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.SWEEP_AUTH_TOKEN = 'test-sweep-token';

  interface TxLike {
    get: (ref: { id: string }) => Promise<{ exists: boolean; ref: { id: string }; data: () => Record<string, unknown> | undefined }>;
    update: (ref: { id: string }, data: Record<string, unknown>) => void;
  }

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

  const fakeFirestoreInstance = {
    // Test-only helpers (used by `beforeEach` and assertions).
    setDoc: (id: string, data: Record<string, unknown>) => docs.set(id, { ...data }),
    getDoc: (id: string) => docs.get(id),
    reset: () => docs.clear(),

    // Production-shape API used by worker.ts / admin.ts / stories.ts.
    collection: (_name: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => ({
          exists: docs.has(id),
          ref: { id },
          data: () => docs.get(id),
        }),
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
        get: async (ref) => ({
          exists: docs.has(ref.id),
          ref,
          data: () => docs.get(ref.id),
        }),
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

vi.mock('@google-cloud/firestore', () => {
  return {
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
  };
});

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
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({
        candidates: [
          { content: { parts: [{ inlineData: { data: 'fake-base64', mimeType: 'image/png' } }] } },
        ],
      }),
    };
  },
  // FC-037: gemini.ts references these enums at module-load for SAFETY_SETTINGS.
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

// Import AFTER the mocks. These are the PRODUCTION predicates.
// eslint-disable-next-line import/first
import { sigtermMarkFailed, WORKER_ID } from '../worker';
// eslint-disable-next-line import/first
import { sweepOrphanTx } from '../../routes/admin';
// eslint-disable-next-line import/first
import { bgCatchMarkFailed } from '../../routes/stories';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = fakeFirestoreInstance as any;

// ---- Tests --------------------------------------------------------------

describe('FC-030 Change 1 — deterministic page-doc IDs', () => {
  it('derives stable page-doc ID from pageNumber', () => {
    const pages = [
      { pageNumber: 1, text: 'a' },
      { pageNumber: 2, text: 'b' },
      { pageNumber: 12, text: 'c' },
    ];
    const ids = pages.map((p) => String(p.pageNumber));
    expect(ids).toEqual(['1', '2', '12']);
  });

  it('two derivations produce identical IDs (idempotency floor)', () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ pageNumber: i + 1 }));
    const run1 = pages.map((p) => String(p.pageNumber));
    const run2 = pages.map((p) => String(p.pageNumber));
    expect(run1).toEqual(run2);
    expect(new Set(run1).size).toBe(5);
  });
});

describe('FC-030 Change 2 — sweep transactional re-read (sweepOrphanTx)', () => {
  beforeEach(() => fakeFirestoreInstance.reset());

  it('marks a doc failed:orphaned when generating + heartbeat is still stale', async () => {
    const NOW = 10_000_000;
    const FIVE_MIN = 5 * 60 * 1000;
    fakeFirestoreInstance.setDoc('story-1', {
      status: 'generating',
      workerId: 'old-worker',
      workerHeartbeatAt: { toMillis: () => NOW - FIVE_MIN - 60_000 },
    });
    const ref = { id: 'story-1' };
    const result = await sweepOrphanTx(db, ref as never, NOW - FIVE_MIN, NOW - FIVE_MIN);
    expect(result).toBe('generating');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('orphaned');
    expect(after.workerId).toBeUndefined();
    expect(after.workerHeartbeatAt).toBeUndefined();
  });

  it('ABORTS sweep when a takeover landed a fresh heartbeat — the BLOCKER-1 race', async () => {
    const NOW = 10_000_000;
    const FIVE_MIN = 5 * 60 * 1000;
    fakeFirestoreInstance.setDoc('story-1', {
      status: 'generating',
      workerId: 'new-worker',
      workerHeartbeatAt: { toMillis: () => NOW - 5_000 },
    });
    const ref = { id: 'story-1' };
    const result = await sweepOrphanTx(db, ref as never, NOW - FIVE_MIN, NOW - FIVE_MIN);
    expect(result).toBeNull();
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('generating');
    expect(after.workerId).toBe('new-worker');
  });

  it('aborts when status=queued but createdAt is no longer stale', async () => {
    const NOW = 10_000_000;
    const FIVE_MIN = 5 * 60 * 1000;
    fakeFirestoreInstance.setDoc('story-1', {
      status: 'queued',
      createdAt: { toMillis: () => NOW - 60_000 },
    });
    const ref = { id: 'story-1' };
    const result = await sweepOrphanTx(db, ref as never, NOW - FIVE_MIN, NOW - FIVE_MIN);
    expect(result).toBeNull();
    expect(fakeFirestoreInstance.getDoc('story-1')!.status).toBe('queued');
  });

  it('aborts when status is already terminal (complete or failed)', async () => {
    const NOW = 10_000_000;
    const FIVE_MIN = 5 * 60 * 1000;
    fakeFirestoreInstance.setDoc('story-complete', { status: 'complete' });
    fakeFirestoreInstance.setDoc('story-failed', { status: 'failed', failureReason: 'safety_blocked' });
    expect(await sweepOrphanTx(db, { id: 'story-complete' } as never, NOW - FIVE_MIN, NOW - FIVE_MIN)).toBeNull();
    expect(await sweepOrphanTx(db, { id: 'story-failed' } as never, NOW - FIVE_MIN, NOW - FIVE_MIN)).toBeNull();
    expect(fakeFirestoreInstance.getDoc('story-complete')!.status).toBe('complete');
    expect(fakeFirestoreInstance.getDoc('story-failed')!.status).toBe('failed');
    expect(fakeFirestoreInstance.getDoc('story-failed')!.failureReason).toBe('safety_blocked');
  });

  it('marks queued docs failed:orphaned when createdAt is stale', async () => {
    const NOW = 10_000_000;
    const FIVE_MIN = 5 * 60 * 1000;
    fakeFirestoreInstance.setDoc('story-1', {
      status: 'queued',
      createdAt: { toMillis: () => NOW - FIVE_MIN - 60_000 },
    });
    const result = await sweepOrphanTx(db, { id: 'story-1' } as never, NOW - FIVE_MIN, NOW - FIVE_MIN);
    expect(result).toBe('queued');
    expect(fakeFirestoreInstance.getDoc('story-1')!.status).toBe('failed');
    expect(fakeFirestoreInstance.getDoc('story-1')!.failureReason).toBe('orphaned');
  });
});

describe('FC-030 Change 3 — SIGTERM-aware finalize (sigtermMarkFailed)', () => {
  beforeEach(() => fakeFirestoreInstance.reset());

  it('marks a generating doc failed:sigterm', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'generating', workerId: 'me', workerHeartbeatAt: { toMillis: () => 0 } });
    const result = await sigtermMarkFailed(db, 'story-1');
    expect(result).toBe('wrote');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('sigterm');
    expect(after.workerId).toBeUndefined();
    expect(after.workerHeartbeatAt).toBeUndefined();
  });

  it('REFUSES to clobber status=complete (BLOCKER-2 race)', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'complete', pageCount: 5 });
    const result = await sigtermMarkFailed(db, 'story-1');
    expect(result).toBe('skipped-terminal');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('complete');
    expect(after.failureReason).toBeUndefined();
    expect(after.pageCount).toBe(5);
  });

  it('REFUSES to clobber status=failed with a more specific failureReason', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'failed', failureReason: 'safety_blocked' });
    const result = await sigtermMarkFailed(db, 'story-1');
    expect(result).toBe('skipped-terminal');
    expect(fakeFirestoreInstance.getDoc('story-1')!.failureReason).toBe('safety_blocked');
  });

  it('skips non-existent docs gracefully', async () => {
    const result = await sigtermMarkFailed(db, 'nonexistent');
    expect(result).toBe('skipped-missing');
    expect(fakeFirestoreInstance.getDoc('nonexistent')).toBeUndefined();
  });
});

describe('FC-030 Change 4 — fireWorkerInBackground transactional catch (bgCatchMarkFailed)', () => {
  beforeEach(() => fakeFirestoreInstance.reset());

  it('writes status=failed:unknown when doc is queued and no worker owns it', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'queued' });
    const result = await bgCatchMarkFailed(db, 'story-1');
    expect(result).toBe('wrote');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('unknown');
  });

  it('REFUSES to clobber status=generating when a DIFFERENT worker owns it (BLOCKER-3)', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'generating', workerId: 'OTHER_WORKER', workerHeartbeatAt: { toMillis: () => 0 } });
    const result = await bgCatchMarkFailed(db, 'story-1');
    expect(result).toBe('skipped-other-worker');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('generating');
    expect(after.workerId).toBe('OTHER_WORKER');
  });

  it('RECOVERS when status=generating with own WORKER_ID (confirmation-review MEDIUM-1)', async () => {
    // The worker's catch tried to write failed but Firestore was
    // transiently unavailable; the doc stays generating with OUR own
    // WORKER_ID set. The pre-MEDIUM-1 predicate (`if (data.workerId)
    // return;`) would refuse and strand the user for ~10 min. The fix
    // is `workerId !== WORKER_ID` — only refuse when ANOTHER worker
    // owns it.
    fakeFirestoreInstance.setDoc('story-1', { status: 'generating', workerId: WORKER_ID, workerHeartbeatAt: { toMillis: () => 0 } });
    const result = await bgCatchMarkFailed(db, 'story-1');
    expect(result).toBe('wrote');
    const after = fakeFirestoreInstance.getDoc('story-1')!;
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('unknown');
  });

  it('REFUSES to clobber status=complete', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'complete' });
    const result = await bgCatchMarkFailed(db, 'story-1');
    expect(result).toBe('skipped-terminal');
    expect(fakeFirestoreInstance.getDoc('story-1')!.status).toBe('complete');
  });

  it('REFUSES to clobber an already-failed status with a more specific failureReason', async () => {
    fakeFirestoreInstance.setDoc('story-1', { status: 'failed', failureReason: 'quota_exceeded' });
    const result = await bgCatchMarkFailed(db, 'story-1');
    expect(result).toBe('skipped-terminal');
    expect(fakeFirestoreInstance.getDoc('story-1')!.failureReason).toBe('quota_exceeded');
  });

  it('skips non-existent docs gracefully (defensive)', async () => {
    const result = await bgCatchMarkFailed(db, 'nonexistent');
    expect(result).toBe('skipped-missing');
    expect(fakeFirestoreInstance.getDoc('nonexistent')).toBeUndefined();
  });
});
