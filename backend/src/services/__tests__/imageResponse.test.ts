/**
 * FC-045 — extractGeneratedImage: final-image extraction that skips interim
 * "thought" images. Pure unit tests, no mocks. See docs/plans/fc-045.md §3.
 */
import { describe, it, expect } from 'vitest';
import { extractGeneratedImage } from '../imageResponse';

const respond = (parts: unknown[]) => ({ candidates: [{ content: { parts } }] }) as never;

describe('FC-045 — extractGeneratedImage', () => {
  it('skips thought image + thought text and returns the final image', () => {
    const r = respond([
      { inlineData: { data: 'DRAFT', mimeType: 'image/png' }, thought: true },
      { text: 'planning the composition', thought: true },
      { inlineData: { data: 'FINAL', mimeType: 'image/jpeg' } },
    ]);
    expect(extractGeneratedImage(r)).toEqual({ data: 'FINAL', mimeType: 'image/jpeg' });
  });

  it('skips a thought image placed AFTER the final image', () => {
    const r = respond([
      { inlineData: { data: 'FINAL', mimeType: 'image/jpeg' } },
      { inlineData: { data: 'DRAFT', mimeType: 'image/png' }, thought: true },
    ]);
    expect(extractGeneratedImage(r)).toEqual({ data: 'FINAL', mimeType: 'image/jpeg' });
  });

  it('returns the only image in a single-part response', () => {
    const r = respond([{ inlineData: { data: 'ONLY', mimeType: 'image/png' } }]);
    expect(extractGeneratedImage(r)).toEqual({ data: 'ONLY', mimeType: 'image/png' });
  });

  it('never falls back to a thought image', () => {
    const r = respond([{ inlineData: { data: 'DRAFT', mimeType: 'image/png' }, thought: true }]);
    expect(extractGeneratedImage(r)).toBeNull();
  });

  it.each([
    ['text-only parts', respond([{ text: 'I cannot draw that.' }])],
    ['empty parts', respond([])],
    ['candidate without content', { candidates: [{}] }],
    ['no candidates', { candidates: [] }],
    ['missing candidates key', {}],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, r) => {
    expect(extractGeneratedImage(r as never)).toBeNull();
  });

  it('skips an image part with an empty-string data payload', () => {
    const r = respond([
      { inlineData: { data: 'REAL', mimeType: 'image/png' } },
      { inlineData: { data: '', mimeType: 'image/jpeg' } },
    ]);
    expect(extractGeneratedImage(r)).toEqual({ data: 'REAL', mimeType: 'image/png' });
    expect(extractGeneratedImage(respond([{ inlineData: { data: '', mimeType: 'image/png' } }]))).toBeNull();
  });

  it("defaults mimeType to 'image/png' when missing or empty", () => {
    expect(extractGeneratedImage(respond([{ inlineData: { data: 'A' } }]))).toEqual({ data: 'A', mimeType: 'image/png' });
    expect(extractGeneratedImage(respond([{ inlineData: { data: 'A', mimeType: '' } }]))).toEqual({ data: 'A', mimeType: 'image/png' });
  });

  it('returns the LAST of multiple non-thought images', () => {
    const r = respond([
      { inlineData: { data: 'A', mimeType: 'image/png' } },
      { inlineData: { data: 'B', mimeType: 'image/jpeg' } },
    ]);
    expect(extractGeneratedImage(r)).toEqual({ data: 'B', mimeType: 'image/jpeg' });
  });

  it('only looks at candidates[0]', () => {
    const r = {
      candidates: [
        { content: { parts: [{ text: 'no image here' }] } },
        { content: { parts: [{ inlineData: { data: 'SECOND', mimeType: 'image/png' } }] } },
      ],
    };
    expect(extractGeneratedImage(r as never)).toBeNull();
  });
});
