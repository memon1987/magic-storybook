/**
 * FC-028 — Pin backend illustration aspect ratio (16:9 landscape).
 *
 * Path B (prompt-level, best-effort): the installed `@google/genai` v0.7.0
 * exposes NO `imageConfig`/`aspectRatio` field on `GenerateContentConfig` (that
 * field lives only on `GenerateImagesConfig`/`GenerateVideosConfig`, which this
 * app's `generateContent` + `responseModalities: ['IMAGE']` pipeline does not
 * use). A config-level pin therefore fails `tsc`. Until the SDK is upgraded
 * (tracked as a follow-up FC), all four image-generation prompt builders append
 * this single shared instruction so the model is asked, uniformly, for a 16:9
 * landscape composition.
 *
 * "Best-effort" is deliberate: the model may not honor the ratio exactly. The
 * mobile reader already handles ratio mismatch (FC-026/FC-038 contain + blurred
 * backdrop); this pin shrinks the letterbox bands for NEW stories only. See
 * docs/plans/fc-028.md.
 *
 * One constant, four call sites (page illustration, character reference, cast
 * reference, title page) — uniformity of char-ref inputs vs page outputs matters
 * for the multi-reference consistency pipeline.
 */
export const ASPECT_RATIO_INSTRUCTION =
  'ASPECT RATIO: Compose the image in landscape 16:9 aspect ratio (noticeably wider than tall).';
