/**
 * FC-045: pure, SDK-free extraction of the final generated image from a
 * Gemini `generateContent` response.
 *
 * Image models with thinking enabled may return interim "thought" images
 * (drafts) before the final render. Those parts carry `thought: true` and must
 * never be uploaded — a draft must not reach a child's book. The final image is
 * the LAST non-thought image part. See docs/plans/fc-045.md.
 *
 * Structural types only (no `@google/genai` import) so this module can be
 * unit-tested without mocking any SDK — same precedent as textVerify.ts.
 */

export interface GeneratedImage {
  data: string;
  mimeType: string;
}

type ImagePartLike = { inlineData?: { data?: string; mimeType?: string }; thought?: boolean };
type ImageResponseLike = { candidates?: Array<{ content?: { parts?: ImagePartLike[] } }> };

/**
 * Returns the last non-thought image part of `candidates[0]`, or null when
 * there is none (no candidates, no parts, text only, or thought images only).
 * Never falls back to a thought image. `mimeType` defaults to 'image/png'.
 */
export function extractGeneratedImage(
  response: ImageResponseLike | null | undefined,
): GeneratedImage | null {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  let found: GeneratedImage | null = null;
  for (const part of parts) {
    if (part?.thought === true) continue;
    const data = part?.inlineData?.data;
    if (typeof data !== 'string' || data.length === 0) continue;
    found = { data, mimeType: part.inlineData?.mimeType || 'image/png' };
  }
  return found;
}
