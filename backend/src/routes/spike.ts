import { Router, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest, ArtStyle } from '../types';
import { generateIllustrationPro, ReferenceImage } from '../services/gemini';
import {
  generateRecraftIllustration,
  createRecraftStyle,
  getRecraftStyleMode,
  CURATED_CHILD_BOOK_STYLE,
} from '../services/recraft';

/**
 * FC-019 spike route — dev/owner-only comparison tool. NOT for production use.
 *
 * Takes an existing story ID, re-generates ALL pages via two alternate
 * pipelines (Gemini 3 Pro Image with text baked in; Recraft V3 with text
 * baked in + a custom style_id derived from the story's FC-013 character
 * refs), and returns side-by-side URLs + latency + estimated cost.
 *
 * Variant A (control) is the existing story's pages.imageUrl — those are
 * already-generated Flash + Skia overlay outputs.
 *
 * Each variant gated by an env var so production behavior is unchanged
 * when this branch is deployed (env vars OFF by default):
 *   - SPIKE_USE_PRO_IMAGE=true   → enables Variant B (Pro Image)
 *   - SPIKE_USE_RECRAFT=true     → enables Variant C (Recraft V3 + style_id)
 *   - RECRAFT_API_KEY=...        → required for Variant C
 *
 * Auth: same authMiddleware as /api/stories. Caller must own the story.
 *
 * Outputs land at `stories/{storyId}/spike-pro/...` and `stories/{storyId}/spike-recraft/...`
 * (separate prefixes from production pages so nothing collides).
 */

const router = Router();
const db = new Firestore();

/**
 * Review fix HIGH-1: route-level kill switch independent of per-variant
 * flags. With SPIKE_ROUTE_ENABLED unset (default in production), the route
 * returns 404 BEFORE auth + Firestore reads, so a leaked Firebase token
 * can't enumerate Firestore via this surface even when the route exists
 * in the deployed binary.
 */
router.use((req, res, next) => {
  if (process.env.SPIKE_ROUTE_ENABLED !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

router.use(authMiddleware);

/**
 * Review fix HIGH-1: hard cap on pages-per-spike-run so a single
 * invocation can't burn unbounded cost (12-page story × 2 variants
 * × $0.20 avg = ~$4.80/run; with this cap, worst case ~$2.40/run).
 */
const MAX_SPIKE_PAGES = 6;

// Rough cost estimates per image, May 2026 prices. Used only for the spike
// report so we can compare "$ per story" across variants. NOT authoritative
// — actual billing is tracked vendor-side.
const COST_PER_IMAGE = {
  proImage: 0.134,  // gemini-3-pro-image-preview at 1K-2K resolution
  recraftV3: 0.04,  // recraftv3 raster generation (style_id is V3-only; ~6x cheaper than V4 quality tier)
} as const;

interface SpikeVariantPage {
  pageNumber: number;
  imageUrl: string;
  latencyMs: number;
}

interface SpikeVariantResult {
  variant: 'B-pro-image' | 'C-recraft-v3';
  enabled: boolean;
  /** Reason if disabled (env var off or missing key). */
  disabledReason?: string;
  pages: SpikeVariantPage[];
  totalLatencyMs: number;
  estimatedCostUSD: number;
  error?: string;
  /**
   * FC-019: how art direction was applied for this variant. For Recraft V3
   * this records whether a custom style_id was created from the FC-013 char
   * refs (fair test) or we fell back to prompt-only (NOT a fair test) — so
   * the visual comparison is never silently mis-attributed.
   */
  styleNote?: string;
}

interface SpikeCompareResponse {
  storyId: string;
  storyTitle: string;
  pageCount: number;
  /** Set to true if story had more pages than MAX_SPIKE_PAGES and we ran on a prefix. */
  truncated: boolean;
  totalStoryPages: number;
  /** Per-story warnings (e.g. missing char sheets, char ref fetch failures). */
  warnings: string[];
  /** Variant A is the existing story's pages.imageUrl (control). */
  control: {
    variant: 'A-flash-skia-overlay';
    pages: Array<{ pageNumber: number; imageUrl: string }>;
    notes: string;
  };
  variantB: SpikeVariantResult;
  variantC: SpikeVariantResult;
}

router.post('/compare-story/:storyId', async (req: AuthRequest, res: Response) => {
  const storyId = req.params.storyId as string;
  const userId = req.user!.uid;

  try {
    // 1) Load the story + pages from Firestore
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
    });

    // Review fix HIGH-1: cap pages per run. If story has more, we spike a
    // subset (first MAX_SPIKE_PAGES) and flag the truncation in response.
    const truncated = allPages.length > MAX_SPIKE_PAGES;
    const pages = truncated ? allPages.slice(0, MAX_SPIKE_PAGES) : allPages;

    const artStyle = (storyData?.artStyle ?? 'watercolor') as ArtStyle;
    const characterSheets = (storyData?.characterSheets ?? []) as Array<{ name: string; description: string }>;
    const settingIdentity = storyData?.settingIdentity as { name: string; description: string } | undefined;
    const animalType = storyData?.favoriteAnimal ?? 'friend';

    // 2) Build character ref images for Variant B from the saved Cloud Storage
    //    URLs (FC-013 saved them as `characterReferenceUrls: Record<name, url>`).
    //    Variant C doesn't get char refs in v1 of the spike (Recraft style refs
    //    are a future test per plan). We download each ref into base64 since
    //    Gemini's multimodal API needs inline image bytes.
    const refsMap = (storyData?.characterReferenceUrls ?? {}) as Record<string, string>;
    const charRefImages: ReferenceImage[] = [];
    for (const [name, url] of Object.entries(refsMap)) {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          // Review fix MEDIUM-2: log non-OK responses so we don't silently
          // run Variant B with missing char refs and wrongly conclude
          // "Pro Image has bad character consistency."
          console.warn(`[SPIKE] Char ref for "${name}" returned HTTP ${r.status} from ${url} — skipping`);
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        // Defensive: Cloud Storage usually preserves content-type, but coerce
        // anything outside image/* to PNG so Gemini's multimodal call doesn't
        // reject the inline data.
        let mime = r.headers.get('content-type') ?? 'image/png';
        if (!mime.startsWith('image/')) mime = 'image/png';
        charRefImages.push({ type: 'character', name, data: buf.toString('base64'), mimeType: mime });
      } catch (e) {
        console.warn(`[SPIKE] Failed to fetch char ref for "${name}":`, e);
      }
    }
    console.log(`[SPIKE] Loaded story ${storyId} (${pages.length} pages, ${charRefImages.length} char refs, style=${artStyle})`);

    // Collect warnings before kicking off the variant runs.
    const warnings: string[] = [];
    if (truncated) {
      warnings.push(
        `Story has ${allPages.length} pages but spike capped at ${MAX_SPIKE_PAGES} (HIGH-1 fix). Running on pages 1..${MAX_SPIKE_PAGES} only.`,
      );
    }
    if (!characterSheets || characterSheets.length === 0) {
      warnings.push(
        'Story has no characterSheets persisted (likely generated before FC-019 fix landed). Variant B will run WITHOUT character-name anchoring in the prompt — its character-consistency results are NOT representative of what Pro Image can do with full FC-013 inputs. Recommend re-running spike against a story generated after FC-019 is deployed.',
      );
    }
    if (charRefImages.length === 0 && Object.keys(refsMap).length > 0) {
      warnings.push(
        `Story has ${Object.keys(refsMap).length} characterReferenceUrls but ALL fetches failed — Variant B will run with zero char ref images.`,
      );
    }

    const control = {
      variant: 'A-flash-skia-overlay' as const,
      pages: pages.map((p) => ({ pageNumber: p.pageNumber, imageUrl: p.imageUrl })),
      notes:
        'IMPORTANT: Variant A is the existing story\'s naked Gemini Flash output (no text — Skia overlay renders only in the mobile reader). For a true side-by-side, open the story in the iOS sim alongside the browser tabs for Variant B + C, OR mentally apply the FC-018 overlay style when comparing. The browser-only comparison is biased toward B/C because they show finished text-in-image pages and A shows naked illustrations.',
    };

    // 3) Variant B: Gemini 3 Pro Image, text baked in
    const variantB: SpikeVariantResult = await runVariantB(
      storyId,
      pages,
      artStyle,
      animalType,
      characterSheets,
      settingIdentity,
      charRefImages,
    );

    // 4) Variant C: Recraft V3 + custom style derived from the SAME FC-013
    //    character refs used by Variant B. The style locks both art look
    //    (playful children's-book) and character identity across pages.
    const variantC: SpikeVariantResult = await runVariantC(storyId, pages, artStyle, charRefImages);

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

async function runVariantB(
  storyId: string,
  pages: Array<{ pageNumber: number; text: string; sceneDescription: string }>,
  artStyle: ArtStyle,
  animalType: string,
  characterSheets: Array<{ name: string; description: string }>,
  settingIdentity: { name: string; description: string } | undefined,
  charRefImages: ReferenceImage[],
): Promise<SpikeVariantResult> {
  if (process.env.SPIKE_USE_PRO_IMAGE !== 'true') {
    return {
      variant: 'B-pro-image',
      enabled: false,
      disabledReason: 'SPIKE_USE_PRO_IMAGE env var is not set to "true"',
      pages: [],
      totalLatencyMs: 0,
      estimatedCostUSD: 0,
    };
  }

  console.log('[SPIKE-PRO] Starting variant B for', pages.length, 'pages');
  const startAll = Date.now();
  const variantPages: SpikeVariantPage[] = [];

  // Sequential to avoid pile-on; this is a dev tool, not production.
  for (const page of pages) {
    const pageStart = Date.now();
    try {
      const result = await generateIllustrationPro(
        page.sceneDescription,
        animalType,
        storyId,
        page.pageNumber,
        page.text,
        artStyle,
        characterSheets,
        settingIdentity,
        charRefImages,
      );
      variantPages.push({ pageNumber: page.pageNumber, imageUrl: result.publicUrl, latencyMs: Date.now() - pageStart });
    } catch (e) {
      console.error(`[SPIKE-PRO] Page ${page.pageNumber} threw:`, e);
      return {
        variant: 'B-pro-image',
        enabled: true,
        pages: variantPages,
        totalLatencyMs: Date.now() - startAll,
        estimatedCostUSD: variantPages.length * COST_PER_IMAGE.proImage,
        error: e instanceof Error ? e.message : 'Unknown',
      };
    }
  }

  return {
    variant: 'B-pro-image',
    enabled: true,
    pages: variantPages,
    totalLatencyMs: Date.now() - startAll,
    estimatedCostUSD: variantPages.length * COST_PER_IMAGE.proImage,
  };
}

async function runVariantC(
  storyId: string,
  pages: Array<{ pageNumber: number; text: string; sceneDescription: string; imageUrl: string }>,
  artStyle: ArtStyle,
  charRefImages: ReferenceImage[],
): Promise<SpikeVariantResult> {
  if (process.env.SPIKE_USE_RECRAFT !== 'true') {
    return {
      variant: 'C-recraft-v3',
      enabled: false,
      disabledReason: 'SPIKE_USE_RECRAFT env var is not set to "true"',
      pages: [],
      totalLatencyMs: 0,
      estimatedCostUSD: 0,
    };
  }
  if (!process.env.RECRAFT_API_KEY) {
    return {
      variant: 'C-recraft-v3',
      enabled: false,
      disabledReason: 'RECRAFT_API_KEY env var is not set',
      pages: [],
      totalLatencyMs: 0,
      estimatedCostUSD: 0,
    };
  }

  console.log('[SPIKE-RECRAFT] Starting variant C for', pages.length, 'pages');
  const startAll = Date.now();
  const variantPages: SpikeVariantPage[] = [];

  // FC-019 run-3: RECRAFT_STYLE_MODE selects the art-direction strategy so
  // each config is a separate spike invocation with NO redeploy. Exhausts
  // the quality/consistency levers before any final decision:
  //   - 'curated'           → Recraft V3's purpose-built "Child book" style
  //                           (best aesthetic; chars via prompt only).
  //   - 'custom_from_pages' → custom style_id from THIS story's rich Gemini
  //                           page images (encodes the playful aesthetic the
  //                           user likes + the in-scene characters). Lead
  //                           hypothesis for fixing the "rudimentary" look.
  //   - 'custom_from_refs'  → custom style_id from FC-013 white-bg model
  //                           sheets (run-2 baseline; kept for regression).
  const mode = getRecraftStyleMode();
  let styleId: string | undefined;
  let curatedStyle: string | undefined;
  let styleNote: string;

  if (mode === 'curated') {
    curatedStyle = CURATED_CHILD_BOOK_STYLE;
    styleNote = `curated style "${CURATED_CHILD_BOOK_STYLE}" (chars via prompt only — aesthetic-ceiling test)`;
  } else {
    // Both custom modes mint ONE style_id, differing only in source images.
    let srcRefs: Array<{ data: string; mimeType: string }> = [];
    let srcDesc = '';
    if (mode === 'custom_from_pages') {
      // Fetch up to 5 of this story's Gemini page images (the rich aesthetic
      // the user already likes; they also show the characters in-scene).
      const pageUrls = pages.map((p) => p.imageUrl).filter(Boolean).slice(0, 5);
      for (const url of pageUrls) {
        try {
          const r = await fetch(url);
          if (!r.ok) { console.warn(`[SPIKE-RECRAFT] page-style ref ${url} HTTP ${r.status}`); continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          let mime = r.headers.get('content-type') ?? 'image/jpeg';
          if (!mime.startsWith('image/')) mime = 'image/jpeg';
          srcRefs.push({ data: buf.toString('base64'), mimeType: mime });
        } catch (e) {
          console.warn(`[SPIKE-RECRAFT] failed to fetch page-style ref ${url}:`, e);
        }
      }
      srcDesc = `${srcRefs.length} Gemini page image(s)`;
    } else {
      srcRefs = charRefImages.map((r) => ({ data: r.data, mimeType: r.mimeType }));
      srcDesc = `${srcRefs.length} FC-013 char model-sheet(s)`;
    }

    if (srcRefs.length === 0) {
      styleNote = `mode=${mode} but ZERO source images — prompt-only fallback (NOT a fair test)`;
    } else {
      try {
        styleId = await createRecraftStyle(srcRefs);
        styleNote = `mode=${mode}: custom style ${styleId} from ${srcDesc}`;
      } catch (e) {
        console.error('[SPIKE-RECRAFT] createRecraftStyle failed; prompt-only fallback:', e);
        styleNote = `mode=${mode} style creation FAILED (${e instanceof Error ? e.message : 'Unknown'}) — prompt-only fallback`;
      }
    }
  }
  console.log(`[SPIKE-RECRAFT] Style strategy: ${styleNote}`);

  for (const page of pages) {
    const pageStart = Date.now();
    // Text-in-image prompt. Recraft V3 treats quoted text as text to render.
    const prompt = `A ${artStyle} children's picture book illustration. Scene: ${page.sceneDescription}\n\nRender this narration text clearly within the illustration: "${page.text}"\n\nThe text should feel hand-lettered and integrated into the composition, like a real picture book. No speech bubbles. No graphic panels or rectangular cards. Text should feel like part of the artwork.`;
    try {
      const result = await generateRecraftIllustration(prompt, storyId, page.pageNumber, artStyle, styleId, curatedStyle);
      variantPages.push({ pageNumber: page.pageNumber, imageUrl: result.publicUrl, latencyMs: Date.now() - pageStart });
    } catch (e) {
      console.error(`[SPIKE-RECRAFT] Page ${page.pageNumber} threw:`, e);
      return {
        variant: 'C-recraft-v3',
        enabled: true,
        pages: variantPages,
        totalLatencyMs: Date.now() - startAll,
        estimatedCostUSD: variantPages.length * COST_PER_IMAGE.recraftV3,
        error: e instanceof Error ? e.message : 'Unknown',
        styleNote,
      };
    }
  }

  return {
    variant: 'C-recraft-v3',
    enabled: true,
    pages: variantPages,
    totalLatencyMs: Date.now() - startAll,
    estimatedCostUSD: variantPages.length * COST_PER_IMAGE.recraftV3,
    styleNote,
  };
}

export default router;
