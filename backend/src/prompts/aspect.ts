/**
 * FC-028 — Pin backend illustration aspect ratio (16:9 landscape).
 *
 * Path B (prompt-level, best-effort): the installed `@google/genai` v0.7.0
 * exposes NO `imageConfig`/`aspectRatio` field on `GenerateContentConfig` (that
 * field lives only on `GenerateImagesConfig`/`GenerateVideosConfig`, which this
 * app's `generateContent` + `responseModalities: ['IMAGE']` pipeline does not
 * use). A config-level pin therefore fails `tsc`. Until the SDK is upgraded
 * (tracked as follow-up FC-042), the two USER-VISIBLE image-generation prompt
 * builders — page illustration and title page — carry this single shared
 * instruction inside their COMPOSITION block so the model is asked for a 16:9
 * landscape composition.
 *
 * SCOPE (review-narrowed from the plan's original "all four sites"): applied to
 * the page + title builders ONLY, NOT to the character-reference or cast-lineup
 * model sheets. Those refs are internal white-background model sheets that are
 * NEVER shown to the user, so the letterboxing motivation (the entire point of
 * FC-028) does not apply to them — pinning them is pure downside on the
 * consistency-critical multi-reference pipeline (it can only shrink the
 * reference figures that anchor every page). Leaving the two refs ratio-free
 * restores their pre-FC-028 status quo. See the FC-028 review + Execution notes.
 *
 * "Best-effort" is deliberate: the model may not honor the ratio exactly. The
 * mobile reader already handles ratio mismatch (FC-026/FC-038 contain + blurred
 * backdrop); this pin shrinks the letterbox bands for NEW stories only. It is
 * deliberately subordinated to the baked-text band (see wording) and placed in
 * the COMPOSITION block, NOT the recency-privileged final slot, so the
 * text-accuracy constraints keep the last word. See docs/plans/fc-028.md.
 */
export const ASPECT_RATIO_INSTRUCTION =
  'Aspect ratio: 16:9 landscape (wider than tall), without shrinking the bottom text band.';
