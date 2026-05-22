import { Router, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest, ArtStyle } from '../types';
import {
  generateIllustrationBaked,
  ReferenceImage,
  SPIKE_IMAGE_MODEL_PRO,
  SPIKE_IMAGE_MODEL_FLASH,
} from '../services/gemini';

/**
 * FC-019 spike route — dev/owner-only comparison tool. NOT for production use.
 *
 * Character-consistency bakeoff (run-4): Recraft excluded (user decision —
 * Gemini quality is preferred). Compares Gemini 3 Pro Image vs Gemini 3.1
 * Flash Image, BOTH with narration text baked into the image, BOTH using a
 * "max consistency" reference strategy:
 *   - FC-013 character model-sheets, PLUS
 *   - an accumulating chain of prior rendered pages as in-scene `prior_page`
 *     references (page 3 sees pages 1-2; page N sees the last few priors),
 *   - generated SEQUENTIALLY so each page can anchor on all prior pages,
 *   - with strong "match exactly" prompt binding (in buildPageContents).
 *
 * Variant A (control) = existing story pages.imageUrl (Flash + Skia overlay).
 *
 * Env gates (all OFF by default → production behavior unchanged):
 *   - SPIKE_ROUTE_ENABLED=true   → route reachable at all (else 404)
 *   - SPIKE_USE_PRO_IMAGE=true   → Variant B (Pro, baked text)
 *   - SPIKE_USE_FLASH_BAKED=true → Variant C (Flash, baked text)
 *
 * Auth: same authMiddleware as /api/stories. Caller must own the story.
 * Outputs land at `stories/{id}/spike-pro/...` and `stories/{id}/spike-flash/...`.
 */

const router = Router();
const db = new Firestore();

// Route-level kill switch (review HIGH-1): 404 BEFORE auth + Firestore reads
// when not explicitly enabled.
router.use((req, res, next) => {
  if (process.env.SPIKE_ROUTE_ENABLED !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

router.use(authMiddleware);

// Hard cap pages-per-run (review HIGH-1) so a single invocation can't burn
// unbounded cost. With 2 variants this caps a run at ~6 × 2 image gens.
const MAX_SPIKE_PAGES = 6;

// Max prior-page refs carried forward, to stay well under Gemini's documented
// 14-image multimodal cap (char refs + this many prior pages + headroom).
const MAX_PRIOR_PAGE_REFS = 4;

// Rough per-image cost (May 2026) for the spike report only — NOT billing.
const COST_PER_IMAGE = {
  proImage: 0.134,   // gemini-3-pro-image-preview
  flashImage: 0.067, // gemini-3.1-flash-image-preview
} as const;

// FC-019 Pro-consistency investigation: how prior rendered pages feed back
// as references. 'accumulate' can propagate a drifted page (e.g. a close-up);
// 'canonical' pins page 1 only; 'sheets_only' uses no prior-page refs.
type RefStrategy = 'accumulate' | 'canonical' | 'sheets_only';

interface SpikeVariantPage {
  pageNumber: number;
  imageUrl: string;
  latencyMs: number;
}

interface SpikeVariantResult {
  variant: 'B-pro-image' | 'C-flash-image';
  enabled: boolean;
  disabledReason?: string;
  pages: SpikeVariantPage[];
  totalLatencyMs: number;
  estimatedCostUSD: number;
  error?: string;
  /** Records the exact reference strategy so the comparison isn't mis-attributed. */
  refStrategy?: string;
}

interface SpikeCompareResponse {
  storyId: string;
  storyTitle: string;
  pageCount: number;
  truncated: boolean;
  totalStoryPages: number;
  warnings: string[];
  control: {
    variant: 'A-flash-skia-overlay';
    pages: Array<{ pageNumber: number; imageUrl: string }>;
    notes: string;
  };
  variantB: SpikeVariantResult; // Pro, baked text
  variantC: SpikeVariantResult; // Flash, baked text
}

router.post('/compare-story/:storyId', async (req: AuthRequest, res: Response) => {
  const storyId = req.params.storyId as string;
  const userId = req.user!.uid;

  try {
    const storyDoc = await db.collection('stories').doc(storyId).get();
    if (!storyDoc.exists) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    const storyData = storyDoc.data();
    if (storyData?.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const pagesSnap = await storyDoc.ref.collection('pages').orderBy('pageNumber').get();
    if (pagesSnap.empty) {
      res.status(400).json({ error: 'Story has no pages to compare' });
      return;
    }
    const allPages = pagesSnap.docs.map((d) => d.data() as {
      pageNumber: number;
      text: string;
      sceneDescription: string;
      imageUrl: string;
      soundEffects?: string[];
      emphasizedWords?: string[];
    });

    const truncated = allPages.length > MAX_SPIKE_PAGES;
    const pages = truncated ? allPages.slice(0, MAX_SPIKE_PAGES) : allPages;

    const artStyle = (storyData?.artStyle ?? 'watercolor') as ArtStyle;
    const characterSheets = (storyData?.characterSheets ?? []) as Array<{ name: string; description: string }>;
    const settingIdentity = storyData?.settingIdentity as { name: string; description: string } | undefined;
    const animalType = storyData?.favoriteAnimal ?? 'friend';

    // Load FC-013 character model-sheets (persisted as characterReferenceUrls).
    const refsMap = (storyData?.characterReferenceUrls ?? {}) as Record<string, string>;
    const charRefImages: ReferenceImage[] = [];
    for (const [name, url] of Object.entries(refsMap)) {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          console.warn(`[SPIKE] Char ref for "${name}" returned HTTP ${r.status} from ${url} — skipping`);
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        let mime = r.headers.get('content-type') ?? 'image/png';
        if (!mime.startsWith('image/')) mime = 'image/png';
        charRefImages.push({ type: 'character', name, data: buf.toString('base64'), mimeType: mime });
      } catch (e) {
        console.warn(`[SPIKE] Failed to fetch char ref for "${name}":`, e);
      }
    }
    console.log(`[SPIKE] Loaded story ${storyId} (${pages.length} pages, ${charRefImages.length} char refs, style=${artStyle})`);

    const warnings: string[] = [];
    if (truncated) {
      warnings.push(`Story has ${allPages.length} pages; capped at ${MAX_SPIKE_PAGES} (HIGH-1). Running pages 1..${MAX_SPIKE_PAGES}.`);
    }
    if (!characterSheets || characterSheets.length === 0) {
      warnings.push('No characterSheets persisted (pre-FC-019 story). Both variants run WITHOUT textual character anchoring — re-run on a post-FC-019 story for a fair consistency test.');
    }
    if (charRefImages.length === 0 && Object.keys(refsMap).length > 0) {
      warnings.push(`${Object.keys(refsMap).length} characterReferenceUrls present but ALL fetches failed — both variants run with zero character ref images.`);
    }

    const control = {
      variant: 'A-flash-skia-overlay' as const,
      pages: pages.map((p) => ({ pageNumber: p.pageNumber, imageUrl: p.imageUrl })),
      notes: 'Variant A is the existing story\'s Flash output (text via Skia overlay in the reader; static URLs show naked illustrations). Open the story in the iOS sim for the real A appearance.',
    };

    // Variant B: Gemini 3 Pro Image, baked text, max-consistency refs.
    // FC-019 Pro-consistency investigation: refStrategy controls how prior
    // pages are fed to the model. Query param overrides env so all strategies
    // can be tested with zero redeploys:
    //   - accumulate (default): model-sheets + last N rendered pages. Risk:
    //     a drifted page (e.g. a close-up) pollutes the blend — hurts Pro,
    //     which blends references more aggressively than Flash.
    //   - canonical: model-sheets + page 1 ONLY (fixed anchor, never drifts).
    //   - sheets_only: model-sheets alone (isolate whether prior-page refs help).
    const refStrategyMode = ((req.query.refStrategy as string) || process.env.REF_STRATEGY || 'accumulate') as RefStrategy;

    const variantB = await runGeminiBakedVariant(
      'pro', storyId, pages, artStyle, animalType, characterSheets, settingIdentity, charRefImages, refStrategyMode,
    );

    // Variant C: Gemini 3.1 Flash Image, baked text.
    const variantC = await runGeminiBakedVariant(
      'flash', storyId, pages, artStyle, animalType, characterSheets, settingIdentity, charRefImages, refStrategyMode,
    );

    const response: SpikeCompareResponse = {
      storyId,
      storyTitle: storyData?.title ?? '(untitled)',
      pageCount: pages.length,
      truncated,
      totalStoryPages: allPages.length,
      warnings,
      control,
      variantB,
      variantC,
    };
    res.json(response);
  } catch (error) {
    console.error('[SPIKE] Compare failed:', error);
    res.status(500).json({ error: 'Spike comparison failed', message: error instanceof Error ? error.message : 'Unknown' });
  }
});

/**
 * Shared runner for both Gemini baked-text variants (Pro and Flash).
 *
 * MAX-CONSISTENCY strategy (user decision, FC-019):
 *  - Generates pages SEQUENTIALLY (no parallelism) so each page can reference
 *    every prior rendered page.
 *  - Each page's references = FC-013 character model-sheets + the last
 *    MAX_PRIOR_PAGE_REFS rendered pages as `prior_page` in-scene anchors.
 *  - Strong "match exactly" binding is applied in buildPageContents.
 * Trade-off: slowest possible pipeline; this measures the consistency ceiling.
 */
async function runGeminiBakedVariant(
  modelKind: 'pro' | 'flash',
  storyId: string,
  pages: Array<{ pageNumber: number; text: string; sceneDescription: string; soundEffects?: string[]; emphasizedWords?: string[] }>,
  artStyle: ArtStyle,
  animalType: string,
  characterSheets: Array<{ name: string; description: string }>,
  settingIdentity: { name: string; description: string } | undefined,
  charRefImages: ReferenceImage[],
  refStrategyMode: RefStrategy,
): Promise<SpikeVariantResult> {
  const variant = modelKind === 'pro' ? 'B-pro-image' as const : 'C-flash-image' as const;
  const envFlag = modelKind === 'pro' ? 'SPIKE_USE_PRO_IMAGE' : 'SPIKE_USE_FLASH_BAKED';
  if (process.env[envFlag] !== 'true') {
    return { variant, enabled: false, disabledReason: `${envFlag} not "true"`, pages: [], totalLatencyMs: 0, estimatedCostUSD: 0 };
  }

  const model = modelKind === 'pro' ? SPIKE_IMAGE_MODEL_PRO : SPIKE_IMAGE_MODEL_FLASH;
  const subdir = modelKind === 'pro' ? 'spike-pro' : 'spike-flash';
  const costPer = modelKind === 'pro' ? COST_PER_IMAGE.proImage : COST_PER_IMAGE.flashImage;
  const refStrategy = `refStrategy=${refStrategyMode}: ${charRefImages.length} char model-sheet(s)` +
    (refStrategyMode === 'accumulate' ? ` + accumulating prior-page chain (last ${MAX_PRIOR_PAGE_REFS})`
      : refStrategyMode === 'canonical' ? ' + page-1 canonical anchor only'
        : ' (no prior-page refs)') +
    '; sequential; playful sound-effect + emphasized-word text enabled';

  console.log(`[SPIKE-${subdir.toUpperCase()}] Starting ${variant}; ${refStrategy}`);
  const startAll = Date.now();
  const variantPages: SpikeVariantPage[] = [];
  const priorPageRefs: ReferenceImage[] = [];
  let canonicalPage1Ref: ReferenceImage | undefined; // fixed anchor for 'canonical'

  for (const page of pages) {
    const pageStart = Date.now();
    // Build the per-page reference set per strategy.
    let priorRefs: ReferenceImage[];
    if (refStrategyMode === 'sheets_only') {
      priorRefs = [];
    } else if (refStrategyMode === 'canonical') {
      priorRefs = canonicalPage1Ref ? [canonicalPage1Ref] : [];
    } else {
      priorRefs = priorPageRefs.slice(-MAX_PRIOR_PAGE_REFS);
    }
    const refs: ReferenceImage[] = [...charRefImages, ...priorRefs];
    try {
      const result = await generateIllustrationBaked(
        page.sceneDescription, animalType, storyId, page.pageNumber, page.text,
        artStyle, characterSheets, settingIdentity, refs, model, subdir,
        page.soundEffects, page.emphasizedWords,
      );
      variantPages.push({ pageNumber: page.pageNumber, imageUrl: result.publicUrl, latencyMs: Date.now() - pageStart });
      if (result.imageBase64) {
        // Accumulate this rendered page as an in-scene anchor (used by 'accumulate').
        priorPageRefs.push({ type: 'prior_page', pageNumber: page.pageNumber, data: result.imageBase64, mimeType: result.mimeType });
        // Capture page 1 as the fixed canonical anchor (used by 'canonical').
        if (!canonicalPage1Ref) {
          canonicalPage1Ref = { type: 'prior_page', pageNumber: page.pageNumber, data: result.imageBase64, mimeType: result.mimeType };
        }
      }
    } catch (e) {
      console.error(`[SPIKE-${subdir.toUpperCase()}] Page ${page.pageNumber} threw:`, e);
      return {
        variant, enabled: true, pages: variantPages,
        totalLatencyMs: Date.now() - startAll,
        estimatedCostUSD: variantPages.length * costPer,
        error: e instanceof Error ? e.message : 'Unknown', refStrategy,
      };
    }
  }

  return {
    variant, enabled: true, pages: variantPages,
    totalLatencyMs: Date.now() - startAll,
    estimatedCostUSD: variantPages.length * costPer,
    refStrategy,
  };
}

export default router;
