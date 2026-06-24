/**
 * Regression test for the story-generation outage where the worker failed with:
 *   Cannot use "undefined" as a Firestore value (found in field
 *   "storyText.pages.`0`.soundEffects").
 *
 * Cause: GeneratedStory pages carry optional fields (soundEffects /
 * emphasizedWords) that gemini.ts normalizes to `undefined` when empty/absent.
 * The FC-017 worker's saveStoryText writes the raw story via update(), and a
 * default Firestore client rejects `undefined`. Fix: construct the Firestore
 * clients with { ignoreUndefinedProperties: true }.
 *
 * This file uses the REAL @google-cloud/firestore serializer (not the in-memory
 * double the other suite mocks), because the bug lives in that serializer's
 * undefined validation. No network: update() validates/serializes synchronously
 * and throws BEFORE any RPC, so we never await the (credential-less) write.
 */
import { describe, it, expect } from 'vitest';
import { Firestore } from '@google-cloud/firestore';

// Mirrors the shape that broke production: a page with undefined optional fields.
const storyWithUndefinedFields = {
  title: 'Test',
  pages: [
    { pageNumber: 1, text: 'Once upon a time', soundEffects: undefined, emphasizedWords: undefined },
  ],
};

describe('Firestore undefined handling (story-generation outage regression)', () => {
  it('reproduces the bug: a default Firestore client rejects undefined nested fields', () => {
    const db = new Firestore({ projectId: 'demo-test' });
    expect(() =>
      db.doc('stories/x').update({ storyText: storyWithUndefinedFields })
    ).toThrow(/Cannot use "undefined"/);
  });

  it('fix: ignoreUndefinedProperties drops undefined optional fields (no validation throw)', () => {
    const db = new Firestore({ projectId: 'demo-test', ignoreUndefinedProperties: true });
    expect(() => {
      // Serialization (the undefined check) runs synchronously here. Swallow the
      // async network rejection — we only assert serialization didn't throw.
      void db.doc('stories/x').update({ storyText: storyWithUndefinedFields }).catch(() => {});
    }).not.toThrow();
  });
});
