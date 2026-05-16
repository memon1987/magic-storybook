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
 * FC-019 spike refinement (post-run-2): switched the default model to
 * `recraftv3`.
 *
 * Why V3, not V4: the custom-style API (POST /v1/styles → style_id created
 * from up to 5 reference images) is **V3-only** — V4/V4.1 support neither
 * the `style` enum nor custom `style_id`. The spike's two open problems
 * (Recraft art not playful enough; characters totally inconsistent across
 * pages) are BOTH solved by deriving a custom style from the story's
 * FC-013 character reference model-sheets and passing that style_id to
 * every page. That path requires V3. V3 is also still the long-form
 * text-rendering leader (was #1 on Artificial Analysis for 5 months),
 * so text quality is not sacrificed.
 *
 * Override via env without a redeploy if needed:
 *   gcloud run services update --set-env-vars=RECRAFT_MODEL=...
 */
const RECRAFT_MODEL = process.env.RECRAFT_MODEL || 'recraftv3';
const STYLE_BASE = 'digital_illustration'; // base category for custom style creation
const DEFAULT_SIZE = '1024x1024';

// FC-019 spike fix (post-run-1): Recraft V4 does NOT support the `style` /
// `substyle` parameters at all — per https://www.recraft.ai/docs/api-reference/styles
// "Styles are not yet supported for V4 models." (Run 1 returned HTTP 400
// "Recraft V4 doesn't support style 'digital_illustration_watercolor'".)
// Only Recraft V2/V3 accept a style enum. V4's design philosophy is fully
// prompt-driven art direction. So we drop the style fields entirely and
// describe the art style in the PROMPT instead (the spike route already
// prefixes "A {artStyle} children's picture book illustration ...").
//
// A short natural-language art-direction phrase per ArtStyle, appended to
// the prompt so V4 has explicit style guidance without the unsupported param.
const STYLE_PHRASE: Record<ArtStyle, string> = {
  'watercolor':        'soft watercolor children\'s picture-book illustration, gentle washes, hand-painted feel',
  'cartoon':           'bright flat cartoon children\'s book illustration, bold clean outlines, playful',
  'storybook-classic': 'classic hand-drawn storybook illustration, warm traditional picture-book style',
  'claymation':        'claymation / stop-motion clay diorama look, soft sculpted forms',
  'studio-ghibli':     'Ghibli-inspired hand-drawn animation style, lush painterly backgrounds',
  'pixar-3d':          'polished 3D animated film style, soft global illumination, expressive characters',
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

interface RefImage {
  data: string; // base64
  mimeType: string;
}

/**
 * FC-019 spike refinement: create a Recraft custom style from the story's
 * FC-013 character reference model-sheets. The returned style_id is then
 * passed to every page generation so all pages share ONE locked visual
 * identity — which simultaneously fixes:
 *   (1) "art not playful / not children's-book enough" — the style is now
 *       derived from OUR watercolor char refs, not Recraft's design-forward
 *       V4 defaults; and
 *   (2) "characters totally different each page" — the same images that
 *       anchor Gemini's FC-013 consistency now anchor Recraft's style.
 *
 * POST /v1/styles is multipart/form-data, V3-only, max 5 images, total
 * <= 5 MB. Returns { id: <uuid> }.
 */
export async function createRecraftStyle(
  refImages: RefImage[],
): Promise<string> {
  const apiKey = process.env.RECRAFT_API_KEY;
  if (!apiKey) {
    throw new Error('RECRAFT_API_KEY is not set — cannot create Recraft style');
  }
  if (refImages.length === 0) {
    throw new Error('createRecraftStyle called with zero reference images');
  }

  // Recraft caps at 5 images / 5 MB total. Take up to 5; if total exceeds
  // ~4.5 MB (headroom under the 5 MB hard cap) drop the largest extras.
  const capped = refImages.slice(0, 5);
  const form = new FormData();
  form.append('style', STYLE_BASE);
  let totalBytes = 0;
  for (let i = 0; i < capped.length; i++) {
    const buf = Buffer.from(capped[i].data, 'base64');
    totalBytes += buf.length;
    if (totalBytes > 4_500_000) {
      console.warn(`[SPIKE-RECRAFT] style refs exceeded ~4.5MB at image ${i}; using first ${i} only`);
      break;
    }
    const ext = capped[i].mimeType.includes('jpeg') || capped[i].mimeType.includes('jpg') ? 'jpg' : 'png';
    form.append('files', new Blob([buf], { type: capped[i].mimeType }), `ref-${i}.${ext}`);
  }

  console.log(`[SPIKE-RECRAFT] Creating custom style from ${capped.length} ref image(s) (~${Math.round(totalBytes / 1024)}KB total, base=${STYLE_BASE})...`);
  const resp = await fetch(`${RECRAFT_BASE_URL}/styles`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` }, // do NOT set Content-Type; fetch sets the multipart boundary
    body: form,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '<no body>');
    throw new Error(`Recraft create-style returned ${resp.status}: ${errText.slice(0, 250)}`);
  }
  const json = (await resp.json()) as { id?: string };
  if (!json.id) {
    throw new Error(`Recraft create-style response missing id: ${JSON.stringify(json).slice(0, 200)}`);
  }
  console.log(`[SPIKE-RECRAFT] Custom style created: ${json.id}`);
  return json.id;
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
  styleId?: string,
): Promise<RecraftIllustrationResult> {
  const apiKey = process.env.RECRAFT_API_KEY;
  if (!apiKey) {
    throw new Error('RECRAFT_API_KEY is not set — cannot run Recraft spike variant');
  }

  const stylePhrase = STYLE_PHRASE[style];
  // Even with a custom style_id locking the visual identity, keep a short
  // art-direction phrase in the prompt as reinforcement (Recraft blends
  // prompt + style). When NO style_id (fallback), the phrase carries all
  // the art direction.
  const finalPrompt = `${prompt}\n\nArt style: ${stylePhrase}.`;
  const body: Record<string, unknown> = {
    prompt: finalPrompt,
    model: RECRAFT_MODEL,
    n: 1,
    size: DEFAULT_SIZE,
    response_format: 'url',
  };
  if (styleId) {
    // style_id (V3-only) locks the visual identity derived from the
    // story's character refs — solves both playfulness + char consistency.
    body.style_id = styleId;
  }

  const payloadBytes = JSON.stringify(body).length;
  console.log(
    `[SPIKE-RECRAFT] Generating page ${pageNumber} with ${RECRAFT_MODEL} (${styleId ? 'style_id=' + styleId.slice(0, 8) : 'prompt-only style: ' + style}) [payload ~${Math.round(payloadBytes / 1024)}KB]...`,
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
