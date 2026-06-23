import { describe, it, expect } from 'vitest';
import { emptyJobState, progressMessage } from '../jobState';

describe('emptyJobState', () => {
  it('returns a clean snapshot keyed to the given storyId', () => {
    const s = emptyJobState('abc-123');
    expect(s.storyId).toBe('abc-123');
    expect(s.attempt).toBe(1);
    expect(s.storyText).toBeUndefined();
    expect(s.characterReferenceUrls).toEqual({});
    expect(s.castReferenceUrl).toBeUndefined();
    expect(s.titlePageImageUrl).toBeUndefined();
    expect(s.pageUrls).toEqual({});
    expect(s.characterRefBytes.size).toBe(0);
    expect(s.anchorPageBytes.size).toBe(0);
  });

  it('returns independent map instances on each call (no shared mutable state)', () => {
    const a = emptyJobState('a');
    const b = emptyJobState('b');
    a.characterRefBytes.set('foo', { data: 'x', mimeType: 'image/png' });
    expect(b.characterRefBytes.size).toBe(0);
  });
});

describe('progressMessage', () => {
  it('returns concise messages for each phase', () => {
    expect(progressMessage('story-text', 0, 1)).toBe('Writing your story...');
    expect(progressMessage('story-text', 1, 1)).toBe('Writing your story...');
    expect(progressMessage('cast', 0, 1)).toBe('Drawing the cast lineup...');
    expect(progressMessage('title', 0, 1)).toBe('Painting the cover...');
    expect(progressMessage('finalizing', 0, 1)).toBe('Almost done...');
  });

  it('includes the character name in char-refs phase when provided', () => {
    // FC-025 L-3: both branches use the already-done counter; previously
    // the with-charName branch was off-by-one ("Drawing Mira... (2 of 3)"
    // after Mira finished as #1).
    expect(progressMessage('char-refs', 1, 3, { charName: 'Mira' })).toContain('Mira');
    expect(progressMessage('char-refs', 1, 3, { charName: 'Mira' })).toContain('1 of 3');
  });

  it('counter is consistent across with-name and without-name branches', () => {
    expect(progressMessage('char-refs', 2, 3)).toBe('Drawing characters... (2 of 3)');
    expect(progressMessage('char-refs', 2, 3, { charName: 'Olu' })).toBe('Drawing Olu... (2 of 3)');
  });

  it('includes the page number in page phases when provided', () => {
    expect(progressMessage('anchor-pages', 1, 2, { pageNumber: 1 })).toContain('page 1 of 2');
    expect(progressMessage('parallel-pages', 4, 6, { pageNumber: 5 })).toContain('page 5 of 6');
  });

  it('counter-based fallback for page phases when no page number given', () => {
    expect(progressMessage('anchor-pages', 0, 2)).toContain('0 of 2');
    expect(progressMessage('parallel-pages', 3, 6)).toContain('3 of 6');
  });
});
