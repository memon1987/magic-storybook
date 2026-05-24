/**
 * FC-019/020: pure, I/O-free helpers for baked-text verification and the
 * page-generation pipeline. Extracted from gemini.ts so they're unit-testable
 * without constructing any Gemini / Storage / Vision clients.
 */

/** Normalize text to a set of comparable lowercase alphanumeric word tokens. */
export function wordTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

export interface BakedTextScore {
  recall: number;    // fraction of intended words present in the OCR output
  precision: number; // fraction of OCR'd words that were intended
}

/**
 * Recall/precision of intended vs OCR-detected text (FC-019, validated against
 * 12 historical renders):
 *  - recall    catches MISSING/garbled text (intended words that didn't render).
 *  - precision catches HALLUCINATED/duplicated text — the dominant Flash failure
 *    was a second gibberish block ("Toonallery it, too drenist") rendered beside
 *    the correct one: recall stays 1.0 there, precision drops (jumble≈0.64 vs
 *    clean≥0.94).
 * Empty intended → perfect (nothing to render). Empty detected with non-empty
 * intended → zero (text expected, none found).
 */
export function scoreText(intendedText: string, detectedText: string): BakedTextScore {
  const intended = wordTokens(intendedText);
  if (intended.length === 0) return { recall: 1, precision: 1 };
  const intendedSet = new Set(intended);
  const detectedSet = new Set(wordTokens(detectedText));
  if (detectedSet.size === 0) return { recall: 0, precision: 0 };
  const recall = [...intendedSet].filter((w) => detectedSet.has(w)).length / intendedSet.size;
  const precision = [...detectedSet].filter((w) => intendedSet.has(w)).length / detectedSet.size;
  return { recall, precision };
}

// Detection thresholds (FC-019, validated on 12 historical renders: 11 clean
// at precision 0.94-1.00, 1 jumble at precision 0.64). A page is regenerated
// when EITHER axis fails. F1 ranks candidates when none fully pass.
export const TEXT_RECALL_MIN = 0.6;
export const TEXT_PRECISION_MIN = 0.75;
// Production attempt cap (FC-020): 2 total generations per page bounds the
// synchronous timeout budget while still re-rolling the ~10% stochastic jumbles.
export const PROD_TEXT_GEN_ATTEMPTS = 2;
export const MAX_TEXT_GEN_ATTEMPTS = 3; // default cap when verifyText is on

// FC-020: how many of the first rendered pages are pinned as fixed "canonical"
// in-scene anchors that every later page references. Pinning the first K (not an
// accumulating chain) means a later page's drift can't propagate, and lets pages
// K+1..N generate in parallel (no inter-page dependency). Validated at K=2.
export const CANONICAL_ANCHOR_PAGES = 2;
// Cap on simultaneous page generations in the parallel phase, to bound peak
// memory / open connections (multimodal payloads are ~4-5MB each). Tunable.
export const PAGE_GEN_CONCURRENCY = 4;

export function bakedTextPasses(s: BakedTextScore): boolean {
  return s.recall >= TEXT_RECALL_MIN && s.precision >= TEXT_PRECISION_MIN;
}
export function bakedTextF1(s: BakedTextScore): number {
  return s.precision + s.recall ? (2 * s.precision * s.recall) / (s.precision + s.recall) : 0;
}

/**
 * FC-020: the verify-and-regenerate contract, as a pure function over a fixed
 * sequence of candidate scores. The real loop in generateIllustration mirrors
 * this exactly (it carries image bytes alongside, so it can't call this
 * directly) — keep the two in sync. Stops at the first passing candidate;
 * otherwise runs the whole sequence and keeps the highest-F1 one.
 */
export function simulateVerifyLoop(scores: BakedTextScore[]): { keptIndex: number; attempts: number } {
  let keptIndex = -1;
  let bestF1 = -1;
  for (let i = 0; i < scores.length; i++) {
    const f1 = bakedTextF1(scores[i]);
    if (f1 > bestF1) {
      bestF1 = f1;
      keptIndex = i;
    }
    if (bakedTextPasses(scores[i])) return { keptIndex: i, attempts: i + 1 };
  }
  return { keptIndex, attempts: scores.length };
}

/**
 * FC-020: split pages into the first K (generated sequentially to establish
 * canonical anchors) and the rest (generated in parallel against those anchors).
 * Clamps K to [0, length].
 */
export function splitForAnchoring<T>(pages: T[], k: number): { sequential: T[]; parallel: T[] } {
  const n = Math.max(0, Math.min(k, pages.length));
  return { sequential: pages.slice(0, n), parallel: pages.slice(n) };
}

/**
 * FC-020: run an async mapper over items with bounded concurrency, preserving
 * input order in the result. Used for the parallel page-generation phase so a
 * 12-page story doesn't fire all image calls at once.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
