import { Storage } from '@google-cloud/storage';
import { v4 as uuid } from 'uuid';
import { ArtStyle } from '../types';

/**
 * FC-019 spike: thin Recraft API client for the text-paradigm comparison.
 *
 * Recraft V4 (current model, Feb 2026 release) is the industry leader for
 * long-form text-in-image — "the only model that can generate images
 * containing full sentences, multi-line copy, headlines, and paragraph text"
 * per multiple 2026 benchmarks. V4 explicitly improved over V3 on text
 * rendering and design control. We use V4 quality tier (~$0.25/img) for
 * the spike, NOT V4.1 (~$0.04/img cost-optimized variant) — we want to
 * test the ceiling first.
 *
 * Endpoint: POST https://external.api.recraft.ai/v1/images/generations
 * Auth:     Authorization: Bearer RECRAFT_API_TOKEN
 * Docs:     https://www.recraft.ai/docs/api-reference/endpoints
 *
 * V1 of the spike client: text-only generation, no reference images. The
 * plan calls for testing whether Gemini char refs can be passed as Recraft
 * style refs — that's a follow-up via Recraft's imageToImage endpoint or
 * style_id. For the first spike pass we measure pure text-in-image quality
 * and character consistency from prompt alone.
 */

const RECRAFT_BASE_URL = 'https://external.api.recraft.ai/v1';

/**
 * Review fix HIGH-3: the exact model string Recraft's API accepts isn't
 * 100% verifiable from docs alone. Vercel AI Gateway uses `recraft-v4`
 * (dashed); Recraft's own JSON example uses `recraftv4_1` (underscored,
 * with a `_1` suffix denoting V4.1). Most likely V4 quality tier is
 * `recraftv4` (no suffix), but if the API returns HTTP 400 with an
 * "invalid model" error during the spike, override via env without a
 * redeploy: `gcloud run services update --set-env-vars=RECRAFT_MODEL=...`.
 *
 * Known candidates worth trying in order if the default 400s:
 *   recraftv4          (default)
 *   recraftv4_0
 *   recraft-v4
 *   recraftv3          (fallback to V3 if V4 naming is wrong)
 */
const RECRAFT_MODEL = process.env.RECRAFT_MODEL || 'recraftv4';
const DEFAULT_SIZE = '1024x1024';

// Map our ArtStyle to Recraft's style/substyle. Recraft's style library is
// "design-forward" so we lean on `digital_illustration` for the kids-book
// substyles and `realistic_image` for the pixar/claymation styles.
//
// `infantile_sketch` is the V3→V4 kids'-book preset; the others are best-fit
// matches from Recraft's style library. If Recraft rejects an unknown substyle
// we fall back to `style` alone (no substyle).
interface RecraftStyleMapping {
  style: string;
  substyle?: string;
}

const STYLE_MAP: Record<ArtStyle, RecraftStyleMapping> = {
  'watercolor':         { style: 'digital_illustration', substyle: 'watercolor' },
  'cartoon':            { style: 'digital_illustration', substyle: 'infantile_sketch' },
  'storybook-classic':  { style: 'digital_illustration', substyle: 'infantile_sketch' },
  'claymation':         { style: 'realistic_image',      substyle: 'studio_portrait' },
  'studio-ghibli':      { style: 'digital_illustration', substyle: 'hand_drawn' },
  'pixar-3d':           { style: 'realistic_image',      substyle: 'studio_portrait' },
};

const storage = new Storage();
const bucketName = process.env.STORAGE_BUCKET!;
const bucket = storage.bucket(bucketName);

export interface RecraftIllustrationResult {
  publicUrl: string;
  imageBase64: string | null;
  mimeType: string;
  /** ms from request start to response received (excludes our re-upload). */
  recraftLatencyMs: number;
}

/**
 * Generate a single illustration via Recraft V4.
 *
 * The prompt should include the narration text VERBATIM with explicit
 * instructions to render it in the image — Recraft V4 is text-aware and
 * will treat quoted strings in the prompt as text to render.
 *
 * Re-uploads Recraft's hosted image into our Cloud Storage bucket for
 * parity with the Gemini pipeline (consistent serving URL, cacheable,
 * survives Recraft URL expiration).
 */
export async function generateRecraftIllustration(
  prompt: string,
  storyId: string,
  pageNumber: number,
  style: ArtStyle = 'watercolor',
): Promise<RecraftIllustrationResult> {
  const apiKey = process.env.RECRAFT_API_KEY;
  if (!apiKey) {
    throw new Error('RECRAFT_API_KEY is not set — cannot run Recraft spike variant');
  }

  const mapping = STYLE_MAP[style];
  const body: Record<string, unknown> = {
    prompt,
    model: RECRAFT_MODEL,
    n: 1,
    size: DEFAULT_SIZE,
    response_format: 'url',
    style: mapping.style,
  };
  if (mapping.substyle) {
    body.substyle = mapping.substyle;
  }

  const payloadBytes = JSON.stringify(body).length;
  console.log(
    `[SPIKE-RECRAFT] Generating page ${pageNumber} with ${RECRAFT_MODEL} (style=${mapping.style}${mapping.substyle ? '/' + mapping.substyle : ''}) [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
  );
  const startTime = Date.now();

  const response = await fetch(`${RECRAFT_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const recraftLatencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text().catch(() => '<no body>');
    console.error(`[SPIKE-RECRAFT] HTTP ${response.status} on page ${pageNumber}: ${errText.slice(0, 500)}`);
    throw new Error(`Recraft API returned ${response.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const firstImage = json.data?.[0];
  if (!firstImage?.url) {
    throw new Error(`Recraft response missing data[0].url: ${JSON.stringify(json).slice(0, 200)}`);
  }

  console.log(`[SPIKE-RECRAFT] Page ${pageNumber} generated in ${recraftLatencyMs}ms; fetching image bytes from ${firstImage.url}`);

  // Recraft returns a temporary CDN URL; re-fetch + re-upload into our bucket
  // so the spike route can return stable URLs the user can compare side-by-side
  // without worrying about Recraft URL expiration.
  const imgResp = await fetch(firstImage.url);
  if (!imgResp.ok) {
    throw new Error(`Failed to fetch Recraft image bytes: HTTP ${imgResp.status}`);
  }
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
  const imageBase64 = imgBuffer.toString('base64');
  const mimeType = imgResp.headers.get('content-type') || 'image/png';

  const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const filename = `stories/${storyId}/spike-recraft/page-${pageNumber}-${uuid()}.${extension}`;
  const file = bucket.file(filename);
  await file.save(imgBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
  console.log(`[SPIKE-RECRAFT] Page ${pageNumber} uploaded: ${publicUrl}`);

  return { publicUrl, imageBase64, mimeType, recraftLatencyMs };
}
