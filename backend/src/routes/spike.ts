import { Router, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest, ArtStyle } from '../types';
import { generateIllustrationPro, ReferenceImage } from '../services/gemini';
import { generateRecraftIllustration } from '../services/recraft';

/**
 * FC-019 spike route — dev/owner-only comparison tool. NOT for production use.
 *
 * Takes an existing story ID, re-generates ALL pages via two alternate
 * pipelines (Gemini 3 Pro Image with text baked in; Recraft V4 with text
 * baked in), and returns side-by-side URLs + latency + estimated cost.
 *
 * Variant A (control) is the existing story's pages.imageUrl — those are
 * already-generated Flash + Skia overlay outputs.
 *
 * Each variant gated by an env var so production behavior is unchanged
 * when this branch is deployed (env vars OFF by default):
 *   - SPIKE_USE_PRO_IMAGE=true   → enables Variant B (Pro Image)
 *   - SPIKE_USE_RECRAFT=true     → enables Variant C (Recraft V4)
 *   - RECRAFT_API_KEY=...        → required for Variant C
 *
 * Auth: same authMiddleware as /api/stories. Caller must own the story.
 *
 * Outputs land at `stories/{storyId}/spike-pro/...` and `stories/{storyId}/spike-recraft/...`
 * (separate prefixes from production pages so nothing collides).
 */

const router = Router();
const db = new Firestore();

router.use(authMiddleware);

// Rough cost estimates per image, May 2026 prices. Used only for the spike
// report so we can compare "$ per story" across variants. NOT authoritative
// — actual billing is tracked vendor-side.
const COST_PER_IMAGE = {
  proImage: 0.134, // gemini-3-pro-image-preview at 1K-2K resolution
  recraftV4: 0.25, // recraftv4 quality tier
} as const;

interface SpikeVariantPage {
  pageNumber: number;
  imageUrl: string;
  latencyMs: number;
}

interface SpikeVariantResult {
  variant: 'B-pro-image' | 'C-recraft-v4';
  enabled: boolean;
  /** Reason if disabled (env var off or missing key). */
  disabledReason?: string;
  pages: SpikeVariantPage[];
  totalLatencyMs: number;
  estimatedCostUSD: number;
  error?: string;
}

interface SpikeCompareResponse {
  storyId: string;
  storyTitle: string;
  pageCount: number;
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
    const pages = pagesSnap.docs.map((d) => d.data() as {
      pageNumber: number;
      text: string;
      sceneDescription: string;
      imageUrl: string;
    });

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
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = r.headers.get('content-type') ?? 'image/png';
        charRefImages.push({ type: 'character', name, data: buf.toString('base64'), mimeType: mime });
      } catch (e) {
        console.warn(`[SPIKE] Failed to fetch char ref for "${name}":`, e);
      }
    }
    console.log(`[SPIKE] Loaded story ${storyId} (${pages.length} pages, ${charRefImages.length} char refs, style=${artStyle})`);

    const control = {
      variant: 'A-flash-skia-overlay' as const,
      pages: pages.map((p) => ({ pageNumber: p.pageNumber, imageUrl: p.imageUrl })),
      notes: 'Existing story pages (Gemini Flash + Skia overlay rendered on mobile). For visual compare, open these in the mobile app since the Skia overlay only renders in the reader.',
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

    // 4) Variant C: Recraft V4, text baked in (no refs in v1)
    const variantC: SpikeVariantResult = await runVariantC(storyId, pages, artStyle);

    const response: SpikeCompareResponse = {
      storyId,
      storyTitle: storyData?.title ?? '(untitled)',
      pageCount: pages.length,
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
  pages: Array<{ pageNumber: number; text: string; sceneDescription: string }>,
  artStyle: ArtStyle,
): Promise<SpikeVariantResult> {
  if (process.env.SPIKE_USE_RECRAFT !== 'true') {
    return {
      variant: 'C-recraft-v4',
      enabled: false,
      disabledReason: 'SPIKE_USE_RECRAFT env var is not set to "true"',
      pages: [],
      totalLatencyMs: 0,
      estimatedCostUSD: 0,
    };
  }
  if (!process.env.RECRAFT_API_KEY) {
    return {
      variant: 'C-recraft-v4',
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

  for (const page of pages) {
    const pageStart = Date.now();
    // Build a text-in-image prompt for Recraft. Recraft V4 treats quoted text
    // in the prompt as text to render literally.
    const prompt = `A ${artStyle} children's picture book illustration. Scene: ${page.sceneDescription}\n\nRender this narration text clearly within the illustration: "${page.text}"\n\nThe text should feel hand-lettered and integrated into the composition, like a real picture book. No speech bubbles. No graphic panels or rectangular cards. Text should feel like part of the artwork.`;
    try {
      const result = await generateRecraftIllustration(prompt, storyId, page.pageNumber, artStyle);
      variantPages.push({ pageNumber: page.pageNumber, imageUrl: result.publicUrl, latencyMs: Date.now() - pageStart });
    } catch (e) {
      console.error(`[SPIKE-RECRAFT] Page ${page.pageNumber} threw:`, e);
      return {
        variant: 'C-recraft-v4',
        enabled: true,
        pages: variantPages,
        totalLatencyMs: Date.now() - startAll,
        estimatedCostUSD: variantPages.length * COST_PER_IMAGE.recraftV4,
        error: e instanceof Error ? e.message : 'Unknown',
      };
    }
  }

  return {
    variant: 'C-recraft-v4',
    enabled: true,
    pages: variantPages,
    totalLatencyMs: Date.now() - startAll,
    estimatedCostUSD: variantPages.length * COST_PER_IMAGE.recraftV4,
  };
}

export default router;
