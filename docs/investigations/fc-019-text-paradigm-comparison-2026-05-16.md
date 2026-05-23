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

### Variant C — Recraft V3 + custom style from FC-013 char refs ✅ (fair run, 2026-05-16)

`styleNote`: **custom style `f35f7370-2acd-4995-82a2-00e487204b7a` from 2 char ref(s)** — the fair path executed (style minted from Bubba + Hubba FC-013 model-sheets, applied to all 4 pages via `style_id`).

| Page | Latency |
|---|---|
| style creation | included in total |
| 1 | 18.7 s |
| 2 | 9.8 s |
| 3 | 8.3 s |
| 4 | 9.9 s |
| **Total** | **47.3 s** for style + 4 pages |
| **Cost** | **$0.16** ($0.04/img — *cheaper than Flash's $0.067*) |

URLs: `stories/79555bf6-…/spike-recraft/page-{1..4}-*.png` (run 2026-05-16, the `f1de4f36 / 07a14d9b / 2990895b / 760b7aa9` set — supersedes all earlier `spike-recraft/` outputs which were the discarded unfair V4 runs).

### Head-to-head (4-page story)

| | A: Flash + Skia overlay | B: Gemini 3 Pro (text-in-image) | C: Recraft V3 + custom style |
|---|---|---|---|
| Text accuracy | 100% (Skia) | ~94-96% (model) | ~elite (V3 #1 long-text 5mo) |
| Text feel | overlay (user-rejected) | baked, author-like | baked, author-like |
| Char consistency | n/a (refs anchor art) | FC-013 multimodal refs | FC-013 refs → custom style |
| Latency (4pg, sequential) | baseline | **190 s** (one 103 s tail) | **47 s** (no tail spikes) |
| Cost (4pg) | $0.27 full pipeline | **$0.536** | **$0.16** |
| Vendor | Google | Google | Recraft (new dep) |

**C is 4× faster and 3× cheaper than B.**

### Run 3 — exhausting Recraft V3 quality + consistency levers (2026-05-16)

User feedback on the run-2 V3 output: notably less playful / more rudimentary than Gemini. Root cause identified: the run-2 custom style was built from FC-013 character **model-sheets** (flat poses on white bg) — Recraft's custom style learns the aesthetic of its training images, so it learned "flat + simple." Not Recraft's ceiling; our input. Run 3 tested all remaining levers (all configs add `controls.artistic_level=5`, landscape `1707x1024`, and a negative_prompt steering off "flat/simple/rudimentary/clip-art"):

| Config | Style source | Latency (4pg) | Cost | URLs |
|---|---|---|---|---|
| **C-refs** (run-2 baseline) | custom style ← FC-013 white-bg model-sheets | 47 s | $0.16 | `spike-recraft/…f1de4f36 / 07a14d9b / 2990895b / 760b7aa9` |
| **C-pages** (run-3) | custom style ← this story's rich Gemini page images | 72 s | $0.16 | `spike-recraft/…b33d0e11 / 26b9cc0a / 1ca9ae89 / faaecde5` |
| **C-curated** (run-3) | Recraft V3 curated `style:"Child book"` (chars via prompt only) | 58 s | $0.16 | `spike-recraft/…d286d05d / e139bfa7 / a0138266 / e5bcb1fe` |

All Recraft V3 configs: ~$0.16/4pg ($0.04/img — cheaper than Flash $0.067), ~50-75 s/4pg sequential (vs Pro's 190 s, no tail spikes).

**Levers now exhausted on Recraft:** model (V3 vs V4 — V4 structurally can't anchor style/chars), style source (model-sheets vs rich pages vs curated), artistic_level (maxed), size (landscape), negative_prompt. Nothing material left untried on Recraft's side. Remaining question is purely visual-quality judgment.

### Final decision matrix — needs user's eyes

Open per-page side by side. Decision criteria below were committed pre-spike.

- **B — Gemini 3 Pro:** `spike-pro/…ecd138f3 / ee7dff6c / 79cddccf / 16035392`
- **C-pages — Recraft V3, style from Gemini pages (lead hypothesis):** see table
- **C-curated — Recraft V3 "Child book":** see table
- **A — current Flash+Skia:** open story `79555bf6` in the iOS sim reader

The decision hinges on: does ANY Recraft config reach Gemini's playfulness/character-quality bar? If yes → Recraft V3 wins on 4× speed + 3× cost. If no → Recraft's aesthetic ceiling is genuinely below Gemini for this product, and the decision narrows to B (Pro, text-in-image) vs A (stay Skia, iterate).

## Decision criteria (committed pre-spike, unchanged)

| If… | Then ship… |
|---|---|
| Pro Image text + char consistency feel author-designed, latency tolerable | Option B — migrate to Pro, remove FC-015/018 overlay |
| Recraft V3 text + illustration + char consistency clearly best | Option D — Recraft V3 migration |
| Recraft V3 text wins but illustration/char consistency worse than Pro | Option C — hybrid (Gemini char refs → Recraft V3 style), or fall back to B |
| Neither beats the Skia overlay on the "author-made" feel | Stay on FC-018, iterate Skia typography |

## DECISION — Flash + baked text + OCR text-repair (2026-05-22/23)

After Recraft was excluded (user call: Gemini quality preferred), the decision narrowed to **Pro vs Flash, both with text baked in**, judged on a fresh **6-page** story generated from scratch ("Motu and Bear's Big Brave Flight", story `4fba3ab0…`, watercolor, bouncy-rhymes, chars Motu + Bear). Decisive split:

| | Character consistency | Text legibility |
|---|---|---|
| **Pro** (gemini-3-pro-image-preview) | **Poor** — the boy changed appearance 3× over 6 pages; even the bear's features drifted. Concluded fundamental: Pro blends references aggressively, so any drifted page pollutes the blend. canonical/anchorPages mitigations did not fix it. | Consistently good |
| **Flash** (gemini-3.1-flash-image-preview) | **Excellent** — cast-lineup ref + first-2-page canonical anchors held the characters and their relative sizes | Good, but **~10% of pages jumble** (stochastic, not length-driven) |

**Winner: Flash.** Character consistency is the harder, more product-critical problem and Flash already solves it; the text jumble is a narrower, fixable defect. Pro's character drift is not fixable with our reference machinery.

### The text fix: OCR detect-and-regenerate (validated, not assumed)

User direction: "validate the text fix first." We did — and validation overturned the obvious first design.

**Failure mode (page 6, render `35bfb3ff`):** not missing text. Flash rendered the correct narration on the left, then **hallucinated a second gibberish block on the right** — "The star brown, Bear saw saimly in the gad … Toonallery it, too drenist and ever domr evenuting!" Every *intended* word is still present.

**Metric correction:** the first implementation scored **word-recall** (fraction of intended words found by OCR). Recall = **1.00** on that jumble → it would have shipped the garbage. Measured across all **12 historical spike-flash renders** (`backend/scripts/validate-ocr-detector.js`, deterministic, real Vision OCR):

| | recall | precision | lenRatio |
|---|---|---|---|
| 11 clean renders | 1.00 | **0.94–1.00** | 1.00–1.10 |
| 1 jumbled render (`35bfb3ff`) | 1.00 | **0.64** | 1.70 |

**Precision separates them; recall does not.** Final rule: **regenerate when `recall < 0.6` OR `precision < 0.75`** (recall guards the missing/garbled mode that didn't appear here but is real; precision guards the hallucinated/duplicated mode that did). Sound-effect words are folded into the intended set so legitimate onomatopoeia doesn't depress precision.

**Live confirmation** (deployed revision, `?verifyText=true`, 6-page run): 6/6 pages passed on attempt 1, recall ≥ 0.97 / precision ≥ 0.94, no false positives, no OCR errors, HTTP 200 in 122 s. The jumble is stochastic so it didn't recur live — the deterministic script above is the proof that a real jumble is caught.

Shipped in PR #20. Mechanics now proven → productionize in **FC-020**.

## Open items

- **FC-020 (next):** migrate production `generateAllIllustrations` to Flash + baked text + cast-lineup + pin-first-K canonical anchors + OCR text-repair; remove FC-015/018 Skia overlay machinery; address the 600 s synchronous-request ceiling (relates to FC-017 async job model — text-verify regenerations add latency).
- Latency footnote: spike runs variants **sequentially**; production `generateAllIllustrations` is parallel. But OCR text-repair forces a partial serialization (a page can't be accepted until its OCR returns), and regenerations add 1–2 extra image-gens to ~10% of pages — FC-020 must budget for this against the 600 s timeout.
- Storage cleanup: spike outputs at `stories/*/spike-{pro,recraft,flash}/` + extra `character-refs/cast-*`. `gsutil rm` once FC-020 lands.
- Spike env flags (`SPIKE_*`) + the unused `RECRAFT_API_KEY` secret to be torn down post-FC-020.
