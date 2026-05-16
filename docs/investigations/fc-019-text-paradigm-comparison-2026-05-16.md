# FC-019 Investigation: Text-rendering paradigm comparison

**Date:** 2026-05-16
**Plan:** `docs/plans/fc-019.md`
**Status:** In progress — Variant B captured; Variant C re-run pending (Recraft V3 + custom style)
**Test story:** `79555bf6-192e-4c55-a9a2-7c56c8f55d81` — "Bubba, Hubba, and the Big Pizza", 4 pages, watercolor, bouncy-rhymes voice, 2 named characters (Bubba + Hubba). Generated post-FC-019-BLOCKER-1-fix so `characterSheets` + `settingIdentity` + `characterReferenceUrls` are all persisted.

---

## Why this investigation exists

After FC-015 (Skia overlay) and FC-018 (refined overlay), user feedback was the overlay paradigm fundamentally doesn't feel like "a true kids book written and illustrated by an author." This spike compares the current pipeline against two text-in-image alternatives, on real story content, before any migration decision. Decision criteria were committed in the plan BEFORE running (no moving goalposts).

## Variants

- **A (control)** — current pipeline: Gemini 3.1 Flash Image, text rendered as a Skia overlay on the mobile reader. The static GCS URLs show *naked* illustrations; the real Variant A is only visible in the iOS sim reader (the overlay is client-side). This is a known comparison bias documented in the spike route's `control.notes`.
- **B** — Gemini 3 Pro Image (`gemini-3-pro-image-preview`), narration text baked into the image, FC-013 character refs passed as multimodal inputs (unchanged anchoring).
- **C** — Recraft, narration text baked into the image. **Evolved during the spike** (see below).

## Key research finding: Recraft V4 is NOT a superset of V3 (capability regression for our use case)

The plan originally picked Recraft **V4** because 2026 benchmarks said V4 improved on V3 for text rendering. The user challenged the assumption that "V4 was a follow-on meant to improve on V3 without losing key capabilities." Deep research (2026-05-16) **refuted that for our use case**:

- **V4 IS a follow-on rebuild** — official Recraft: "ground-up rebuild focused on visual taste, prompt accuracy, output quality; typography treated as a structural component." Genuinely better raw generator + text.
- **BUT V4 dropped a key V3 capability: custom styles / style presets.** Authoritative, repeated across sources:
  - Recraft styles API doc (verbatim): "Recraft V4, Recraft V4 Vector, Recraft V4 Pro, Recraft V4 Vector Pro: **styles are not supported**." Same for the entire **V4.1** line including V4.1 **Utility**.
  - Recraft via Vercel AI Gateway FAQ: *"V3's strengths are style presets and vector output. Choose V4 when… photorealism and composition goals outweigh **preset-driven workflows**."* — Recraft itself frames V4 as a *different tradeoff*, not a superset.
  - No roadmap/timeline for V4 style support; stated as a flat current limitation. No documented V4 image-to-image / reference-image alternative either.
- **Custom styles are the ONLY Recraft primitive that solves our two open problems** with the Recraft variant:
  1. *Art not playful / not children's-book enough* — a custom style derived from our own watercolor character model-sheets replaces Recraft's design-forward defaults.
  2. *Characters totally inconsistent across pages* — the same FC-013 character refs that anchor Gemini's consistency become the style's visual identity, shared across every page.
  That primitive (`POST /v1/styles` → `style_id`) is **V3-only** by Recraft's own documentation.

**Conclusion:** For a personalized children's book where character consistency + a specific hand-painted style are paramount, **Recraft V3 + custom-style-from-refs is the architecturally correct Recraft path** — not because V3 is newer/better (it isn't), but because it is the only Recraft model with the capability the product requires. V3's text rendering is still elite (held #1 on Artificial Analysis long-text for 5 months), so the dimension the plan originally chose V4 for is barely sacrificed. The V4 spike output (flat art, character drift) is therefore **not representative of Recraft's ceiling** — it was V4 with zero style anchoring because V4 *structurally cannot* take style references.

## Data captured so far

### Variant B — Gemini 3 Pro Image (text baked in) ✅ (spike run 1, 2026-05-16)

| Page | Latency |
|---|---|
| 1 | 33.8 s |
| 2 | 102.9 s (tail-latency event) |
| 3 | 20.4 s |
| 4 | 32.4 s |
| **Total** | **190 s** for 4 pages |
| **Cost** | **$0.536** ($0.134/img — ~2× Flash) |

URLs: `stories/79555bf6-…/spike-pro/page-{1..4}-*.jpg`

### Variant C — Recraft V4, prompt-only (spike run 1–2) ❌ NOT a fair test

- Run 1: HTTP 400 — `Recraft V4 doesn't support style 'digital_illustration_watercolor'` (sent V3-era style enum; V4 rejects it).
- Run 2 (after dropping the style param, V4 prompt-only): generated, but **flat/un-playful art + complete character drift across pages** — expected, because V4 has no mechanism to anchor either style or characters. This run is discarded as non-representative per the research finding above.
- Latency on the successful V4 prompt-only run: ~76 s for 4 pages (17–21 s/page, very consistent — no tail spikes). Cost basis at the time assumed V4 quality tier (~$0.25/img).

### Variant C — Recraft V3 + custom style from FC-013 char refs ⏳ PENDING

Implementation complete (this PR): the spike now (1) loads the story's persisted FC-013 character reference model-sheets, (2) calls `POST /v1/styles` once to mint a `style_id` from them (`createRecraftStyle`), (3) passes that `style_id` + `model: recraftv3` to every page. `styleNote` in the response records whether the fair path (custom style) or the unfair fallback (prompt-only) was used, so the comparison can never be silently mis-attributed. Cost basis corrected to V3 raster (~$0.04/img — ~6× cheaper than the V4 quality tier, and cheaper than Flash). **Re-run results to be appended here.**

## Decision criteria (committed pre-spike, unchanged)

| If… | Then ship… |
|---|---|
| Pro Image text + char consistency feel author-designed, latency tolerable | Option B — migrate to Pro, remove FC-015/018 overlay |
| Recraft V3 text + illustration + char consistency clearly best | Option D — Recraft V3 migration |
| Recraft V3 text wins but illustration/char consistency worse than Pro | Option C — hybrid (Gemini char refs → Recraft V3 style), or fall back to B |
| Neither beats the Skia overlay on the "author-made" feel | Stay on FC-018, iterate Skia typography |

## Open items

- Variant C V3 fair re-run (next).
- Latency footnote: spike runs variants **sequentially**; production `generateAllIllustrations` is parallel, so per-story wall-clock in production would be ~N/concurrency faster than the numbers here.
- Storage cleanup: spike outputs accumulate at `stories/*/spike-{pro,recraft}/`. Add a `gsutil rm` step or lifecycle rule once the decision lands.
