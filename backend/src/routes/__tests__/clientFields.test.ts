/**
 * PR-29 MEDIUM-6: `pickClientFields` is the load-bearing privacy boundary
 * between the Phase 2 schema (which contains worker internals) and the
 * client-facing response. Round 2 of the FC-025 review flagged the
 * raw `...storyData` spread that was leaking workerId / workerHeartbeatAt /
 * storyText / pageUrls / attempt / castAttempted / titleAttempted. The
 * allowlist replaced it; this test asserts the allowlist actually drops
 * each forbidden field.
 */
import { describe, it, expect, vi } from 'vitest';

// stories.ts transitively imports worker.ts → gcsDownload.ts which throws
// at module load on missing env vars (FC-025 L-1). Hoist env setup above
// all imports so the throw doesn't fire.
vi.hoisted(() => {
  process.env.STORAGE_BUCKET = 'test-bucket';
  process.env.GEMINI_API_KEY = 'test-key';
});

import { pickClientFields, CLIENT_VISIBLE_DOC_FIELDS } from '../stories';

// FC-031 Change 6(a): `attempt` was removed from this blocklist and added
// to CLIENT_VISIBLE_DOC_FIELDS so mobile can enforce the retry budget
// (cap auto-Resume at 3 attempts on a failed story). It's a simple
// counter; not a privacy concern.
const INTERNAL_FIELDS = [
  'workerId',
  'workerHeartbeatAt',
  'storyText',
  'pageUrls',
  'castAttempted',
  'titleAttempted',
] as const;

describe('pickClientFields (FC-025 H-2 + PR-29 MEDIUM-6)', () => {
  it('strips every internal Phase-2 field even when present', () => {
    const dirty = {
      userId: 'user-1',
      title: 'A Story',
      status: 'complete',
      pageCount: 5,
      attempt: 3, // FC-031 Change 6(a): now allowlisted; sanity-checked separately below
      // Forbidden / internal fields below.
      workerId: 'storybook-api-00119-abc',
      workerHeartbeatAt: { _seconds: 1, _nanoseconds: 0 },
      storyText: { pages: [{ text: 'hi' }] },
      pageUrls: { '1': { url: 'x', ocrPassed: true, attempts: 1 } },
      castAttempted: true,
      titleAttempted: false,
    };
    const clean = pickClientFields(dirty);
    for (const k of INTERNAL_FIELDS) {
      expect(clean, `${k} must not appear in client response`).not.toHaveProperty(k);
    }
    // Sanity: legitimate fields survive.
    expect(clean.userId).toBe('user-1');
    expect(clean.title).toBe('A Story');
    expect(clean.status).toBe('complete');
    expect(clean.pageCount).toBe(5);
    // FC-031 Change 6(a): `attempt` is now part of the client-visible
    // allowlist (mobile uses it for the retry budget). Was internal.
    expect(clean.attempt).toBe(3);
  });

  it('drops keys that are present-but-undefined (Firestore null-vs-absent semantics)', () => {
    const data = {
      title: 'Story',
      childName: undefined,
      pageCount: undefined,
    };
    const clean = pickClientFields(data);
    expect(clean.title).toBe('Story');
    // childName is in the allowlist but undefined → must not appear in the
    // output (otherwise client sees `{ childName: undefined }` which is
    // JSON-serializes-to-missing but TS-narrows-incorrectly).
    expect(clean).not.toHaveProperty('childName');
    expect(clean).not.toHaveProperty('pageCount');
  });

  it('returns empty object on empty input (no crash)', () => {
    expect(pickClientFields({})).toEqual({});
  });

  it('ignores unknown fields (extra Firestore fields not yet in schema)', () => {
    const data = {
      title: 'Story',
      unknownFutureField: 'leak-me',
      anotherInternal: { secret: true },
    };
    const clean = pickClientFields(data);
    expect(clean.title).toBe('Story');
    expect(clean).not.toHaveProperty('unknownFutureField');
    expect(clean).not.toHaveProperty('anotherInternal');
  });

  it('allowlist has no overlap with the internal-fields blocklist (regression guard)', () => {
    const allow = new Set<string>(CLIENT_VISIBLE_DOC_FIELDS as readonly string[]);
    for (const k of INTERNAL_FIELDS) {
      expect(allow.has(k), `${k} accidentally added to the allowlist`).toBe(false);
    }
  });
});
