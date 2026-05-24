import { describe, it, expect } from 'vitest';
import {
  scoreText,
  isRetryableError,
  bakedTextPasses,
  bakedTextF1,
  simulateVerifyLoop,
  splitForAnchoring,
  mapWithConcurrency,
  TEXT_PRECISION_MIN,
  TEXT_RECALL_MIN,
  type BakedTextScore,
} from '../textVerify';

// The real FC-019 page-6 narration + the hallucinated gibberish block the model
// rendered beside it (captured via Cloud Vision during the spike). Recall stays
// ~1.0 because every intended word is present; precision drops because of the
// extra non-intended words — the failure recall-only missed.
const PAGE6_INTENDED =
  'The star is now out and it shines in the sky. ' +
  'It waves a gold hand as they wave back "Goodbye!" ' +
  'They did a big thing and they feel very glad. ' +
  'To be very brave is the best thing they\'ve had!';
const PAGE6_JUMBLE_OCR =
  PAGE6_INTENDED + ' ' +
  'The star brown, Bear saw saimly in the gad. ' +
  'They wave, they are on by cooling easy and glad. ' +
  'Toonallery it, too dreirist and ever domr evenuting! 0000';

describe('scoreText', () => {
  it('clean render: identical text scores perfect on both axes and passes', () => {
    const s = scoreText(PAGE6_INTENDED, PAGE6_INTENDED);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(bakedTextPasses(s)).toBe(true);
  });

  it('hallucinated extra text (real page-6 jumble): recall high, precision low → fails', () => {
    const s = scoreText(PAGE6_INTENDED, PAGE6_JUMBLE_OCR);
    expect(s.recall).toBe(1); // every intended word still present
    expect(s.precision).toBeLessThan(TEXT_PRECISION_MIN); // gibberish drags precision down
    expect(s.precision).toBeGreaterThan(0.5); // ~0.64 in practice — sanity bound
    expect(bakedTextPasses(s)).toBe(false); // the case recall-only would have shipped
  });

  it('missing/garbled text: nothing detected → zero on both axes → fails', () => {
    const s = scoreText(PAGE6_INTENDED, '');
    expect(s).toEqual({ recall: 0, precision: 0 });
    expect(bakedTextPasses(s)).toBe(false);
  });

  it('partial render: only some intended words present → recall below 1', () => {
    const s = scoreText('the quick brown fox jumps', 'the quick brown');
    // intended tokens (len>1): the, quick, brown, fox, jumps = 5; detected = 3 of them.
    expect(s.recall).toBeCloseTo(3 / 5, 5);
    expect(s.precision).toBe(1); // all detected words are intended
  });

  it('empty intended text → perfect (nothing was supposed to render)', () => {
    expect(scoreText('', 'anything here')).toEqual({ recall: 1, precision: 1 });
    expect(scoreText('!!! ?', 'x')).toEqual({ recall: 1, precision: 1 }); // no tokens len>1
  });

  it('ignores punctuation, case, and single-char tokens', () => {
    const s = scoreText('Hello, WORLD!', 'a hello world');
    // intended tokens: hello, world (len>1). detected: hello, world (a dropped).
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });
});

describe('isRetryableError', () => {
  it('retries real transient Gemini 5xx errors', () => {
    expect(isRetryableError(new Error('ServerError: got status: 500 Internal Server Error. {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}'))).toBe(true);
    expect(isRetryableError(new Error('got status: 503 Service Unavailable. {"error":{"code":503,"status":"UNAVAILABLE"}}'))).toBe(true);
    expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(false); // no status/code context, no keyword → not retried (acceptable: rare from this client)
    expect(isRetryableError(new Error('The model is overloaded due to high demand'))).toBe(true);
  });

  it('retries network resets', () => {
    expect(isRetryableError(new Error('FetchError: request failed, reason: ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT retry non-retryable errors carrying stray numbers/words (review false-positives)', () => {
    expect(isRetryableError(new Error('429: limit is 60 per 500 seconds'))).toBe(false); // quota — retrying makes it worse
    expect(isRetryableError(new Error('500 tokens generated'))).toBe(false);
    expect(isRetryableError(new Error('400 Bad Request: INTERNAL_ID malformed'))).toBe(false);
    expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
    expect(isRetryableError(new Error('RESOURCE_EXHAUSTED'))).toBe(false);
  });

  it('handles non-object inputs', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('500')).toBe(false);
  });
});

describe('bakedTextPasses / bakedTextF1', () => {
  it('passes only when BOTH axes meet their minimums', () => {
    expect(bakedTextPasses({ recall: TEXT_RECALL_MIN, precision: TEXT_PRECISION_MIN })).toBe(true);
    expect(bakedTextPasses({ recall: TEXT_RECALL_MIN - 0.01, precision: 1 })).toBe(false);
    expect(bakedTextPasses({ recall: 1, precision: TEXT_PRECISION_MIN - 0.01 })).toBe(false);
  });

  it('F1 is the harmonic mean; 0 when both are 0', () => {
    expect(bakedTextF1({ recall: 1, precision: 1 })).toBe(1);
    expect(bakedTextF1({ recall: 0, precision: 0 })).toBe(0);
    expect(bakedTextF1({ recall: 1, precision: 0.5 })).toBeCloseTo(2 / 3, 5);
  });
});

describe('simulateVerifyLoop (regenerate contract)', () => {
  const pass: BakedTextScore = { recall: 1, precision: 1 };
  const fail: BakedTextScore = { recall: 1, precision: 0.64 };
  const worseFail: BakedTextScore = { recall: 1, precision: 0.40 };

  it('keeps the first candidate when it passes (no wasted regeneration)', () => {
    expect(simulateVerifyLoop([pass, pass])).toEqual({ keptIndex: 0, attempts: 1 });
  });

  it('regenerates past a failing candidate and keeps the one that passes', () => {
    expect(simulateVerifyLoop([fail, pass])).toEqual({ keptIndex: 1, attempts: 2 });
  });

  it('when none pass, keeps the highest-F1 candidate and uses all attempts', () => {
    // attempt 0 has higher precision (higher F1) than attempt 1 → keep index 0.
    expect(simulateVerifyLoop([fail, worseFail])).toEqual({ keptIndex: 0, attempts: 2 });
    expect(simulateVerifyLoop([worseFail, fail])).toEqual({ keptIndex: 1, attempts: 2 });
  });
});

describe('splitForAnchoring', () => {
  const pages = [1, 2, 3, 4, 5];
  it('splits first K sequential, rest parallel', () => {
    expect(splitForAnchoring(pages, 2)).toEqual({ sequential: [1, 2], parallel: [3, 4, 5] });
  });
  it('clamps K above length (all sequential, none parallel)', () => {
    expect(splitForAnchoring(pages, 99)).toEqual({ sequential: [1, 2, 3, 4, 5], parallel: [] });
  });
  it('K=0 → all parallel', () => {
    expect(splitForAnchoring(pages, 0)).toEqual({ sequential: [], parallel: [1, 2, 3, 4, 5] });
  });
  it('empty pages', () => {
    expect(splitForAnchoring([], 2)).toEqual({ sequential: [], parallel: [] });
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the result', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return null;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // actually ran concurrently
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});
