# Future Considerations

A running list of things we want to **research and write a plan for** before coding. This file is a **precursor to todos**, not a todo list itself. Entries here are ideas and open questions — they become actionable only after a plan file is published in `docs/plans/`.

## Lifecycle

```
1. Consideration  →  added here, loosely scoped, questions open
2. Research        →  investigation, data gathering, comments, alternatives
3. Plan published  →  a file in docs/plans/fc-NNN.md with the agreed approach
4. Execution       →  code changes are made against the plan
5. Archived        →  moved to "Completed" below with a link to the plan + PR
```

**Rule of thumb:** nothing graduates from this file into code until step 3 is done. See project `CLAUDE.md` ("Plan-First Development") for the enforcement rule.

---

## Entry template

Copy this when adding a new consideration. Keep it short — detail belongs in the eventual plan file, not here.

```markdown
### FC-NNN: <short title>

**Status:** Consideration | Researching | Plan drafted | Plan published | Executing | Done
**Size estimate:** S | M | L  (M/L require a plan file before code changes)
**Owner:** <who is thinking about this>
**Plan file:** `docs/plans/fc-NNN.md` (once published)

**Problem / opportunity:** 1–3 sentences on what prompted this.

**Open questions:**
- ...
- ...
```

---

## Active Considerations

### FC-003: Text-to-speech narration

**Status:** Consideration
**Size estimate:** L
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Parents want to use the app as a bedtime story reader. Adding AI narration would let children listen while viewing illustrations.

**Open questions:**
- Google Cloud TTS vs ElevenLabs vs other providers?
- Per-page audio or full-story audio?
- Offline caching of audio?
- Cost per story narration?

---

### FC-004: Multi-language support

**Status:** Consideration
**Size estimate:** L
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Expand to non-English-speaking families. Story text generation, UI localization, and text-in-image rendering all need to support multiple languages.

**Open questions:**
- Which languages first? Spanish, French, Mandarin?
- Does Gemini 3 Pro Image render non-Latin scripts accurately?
- i18n framework for the mobile app?

---

### FC-005: Story sharing & gifting

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Let parents share stories with family members or gift personalized stories to other families.

**Open questions:**
- Share as read-only link or transferable asset?
- Deep linking into the app?
- Privacy implications of sharing child data?

---

### FC-006: Subscription & payment integration

**Status:** Consideration
**Size estimate:** L
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Monetization. Free tier (N stories/month) + paid subscription for unlimited generation.

**Open questions:**
- RevenueCat vs direct Apple/Google IAP?
- Pricing tiers?
- What constitutes the free tier limit?

---

### FC-007: Offline story caching

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Stories should be readable without internet after initial download. Important for airplane/car use cases.

**Open questions:**
- Cache images locally via expo-file-system?
- How much local storage per story (5-12 images)?
- Eviction policy?

---

### FC-009: Infrastructure improvements

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** No staging environment, no build notifications, no monitoring/alerting on Cloud Run.

**Open questions:**
- Staging Cloud Run service with separate Firestore collection?
- Slack webhook for Cloud Build failures?
- What latency/error thresholds to alert on?

---

### FC-010: Parent dashboard & reading analytics

**Status:** Consideration
**Size estimate:** L
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** Parents want to see reading habits — stories read, time spent, favorite themes.

**Open questions:**
- Track events in Firestore or dedicated analytics (Mixpanel, Amplitude)?
- Privacy-first design (data stays local vs cloud)?
- Visualizations in-app or web dashboard?

---

### FC-019: Re-evaluate text rendering paradigm (text-in-image spike)

**Status:** Spike complete (PRs #15–#20 merged). **Decision: bake text into the image (Flash) +
OCR detect-and-regenerate; reject Pro (char drift); exclude Recraft.** Productionization tracked in
**FC-020**. See `docs/investigations/fc-019-text-paradigm-comparison-2026-05-16.md`.
**Size estimate:** M for the spike; L for the migration (FC-020)
**Owner:** Zeshan / Claude
**Plan file:** `docs/plans/fc-019.md`

**Problem / opportunity:** After shipping FC-015 (Skia overlay) and FC-018 (refined overlay), user feedback is that the overlay paradigm fundamentally doesn't feel "like a true kids book written and illustrated by an author." Real kids' books co-design text + illustration — text is part of the composition, not labeled on top. Plan: backend-only spike comparing current pipeline (Gemini Flash + Skia overlay) vs Gemini 3 Pro Image (text baked in, ~94-96% accuracy, Google's forward image lane) vs Recraft V4 (purpose-built for kids'-book illustration WITH multi-line text — only model with this combo per multiple 2026 benchmarks). Feature-flagged behind env vars; no production traffic touched. Comparison gates the migration decision.

**Open questions:**
- Will Recraft V4 character consistency hold up when fed Gemini's character refs as style refs?
- Does Pro Image's latency cost (real ~24-35s/img vs Flash ~12-30s typical) outweigh its 4-6% text-accuracy edge?
- Is GPT Image 1.5 worth a follow-up spike if Pro + Recraft both fall short?

---

### FC-017: Story generation reliability — request resumes / async job model

**Status:** Executing — Phase 1 instrumentation merged (PR #23, `f5f9cb5`, 2026-05-27); Phase 1 investigation note + Phases 2-4 still pending
**Size estimate:** L (likely architecture refactor)
**Owner:** unassigned
**Plan file:** [docs/plans/fc-017.md](plans/fc-017.md)

**FC-020 evidence (2026-05-24):** an 8-page production story took **440s** wall-clock, of which the **character-reference stage alone was ~332s** — one ref hit a 503 and took ~331s (Gemini image latency is non-deterministic, 5-15× over spec per [session 2026-04-28]). The page stage (baked text + OCR) was only ~62s. Two takeaways for this FC: (1) the sync model's real failure mode is a slow/again-retried char ref pushing total past the mobile 600s client timeout — when that fires the **backend keeps running to 3600s, finishes, and saves the story**, so the user sees an error but the story silently appears later (a resume/notify model fixes exactly this); (2) char refs are the stage most worth making resumable/cached. The 600s ceiling is the **client axios timeout** (`mobile/services/api.ts`), NOT Cloud Run (3600s, pinned in `cloudbuild.yaml`).

**Problem / opportunity:** Today story generation is a single synchronous HTTP request that runs for 3-5 minutes (FC-013 + FC-012 + FC-015 pipeline). Real failure observed 2026-05-12: ~9.5 min into a request, the Cloud Run instance handling it died (likely cascading from a `TypeError: fetch failed sending request` blip between Cloud Run and Gemini API while generating a character reference). The request was ~80% done — had story text, 1 of 2 char refs, title page; was mid page-1 generation. A new Cloud Run instance booted but did NOT pick up the orphaned request. Mobile client (10 min HTTP timeout) just waited until timeout, then surfaced a generic failure to the user. **80%+ of the work was already paid for and got thrown away.**

This isn't a one-off — any 3-5 min synchronous request is fragile by definition under autoscaling, instance restarts, network blips, or Cloud Run cold-eviction policies.

**Open questions:**

*Architecture:*
- Should story generation move to an **async job model**? Mobile client POSTs job → gets a job ID immediately → polls a status endpoint (or subscribes to Firestore doc updates, since we already use Firestore). Backend runs the job as a Cloud Run background task or Cloud Tasks-triggered worker, with the job state persisted to Firestore at every step so a crashed instance can resume from the last persisted phase.
- If async: where does the worker run? Same Cloud Run service with a `?background=true` route? Separate Cloud Run service? Cloud Tasks → Cloud Run? Cloud Functions?
- For the resume case specifically: persist intermediate artifacts (char ref URLs, title page URL, completed page URLs) to Firestore on each phase boundary. A resumed worker reads what's done and only generates what's missing.

*UX / mobile client:*
- During the 3-5 min wait, does the user see anything more than a spinner? Even a "Generating page 3 of 6..." progress indicator would massively reduce the abandon rate. Trivial to wire up if we have a status endpoint.
- On client-side timeout, can we surface a "Resume in background — we'll notify you when done" instead of a hard error?

*Reliability:*
- Why did the Cloud Run instance die? Investigation needed. Candidates: OOM (multimodal image payloads are 600KB+ each, parallel generation × N pages could spike memory), connection pool exhaustion, Cloud Run's own kill signals during scale-down.
- Should char-ref retries have circuit-breaker behavior so 3 fails on one ref don't take down the instance with stuck connections?
- Logging gap: when an instance dies, we lose which request it was handling. Add a final orphan-request sweep that marks pending Firestore docs as failed after N minutes of no progress.

*Cost / footprint:*
- An async job model adds ~30 sec polling overhead per story. Acceptable trade-off vs the current "all-or-nothing 5-min synchronous request"?
- Cloud Run min-instances=1 would prevent cold starts but adds ~$15/mo. Worth it once usage justifies?

**Investigation needed before any plan:** root-cause the 2026-05-12 instance death (Cloud Run instance metrics + memory profile during a story generation). Without knowing whether instances die from OOM vs network vs scaledown, we'd be solving the wrong layer.

---

### FC-016: Story generation latency reduction (deep research)

**Status:** Executing — Phase 1 instrumentation merged (PR #23, `f5f9cb5`, 2026-05-27); Phase 1 baseline sweep + investigation note + Phases 2-4 still pending
**Size estimate:** M-L (research first, then implementation)
**Owner:** unassigned
**Plan file:** [docs/plans/fc-016.md](plans/fc-016.md)

**Update — FC-020 reframed the bottleneck (2026-05-24):** the page-parallelization lever this entry hypothesizes was largely *implemented* by FC-020 (pages now generate parallel against fixed canonical anchors; the page stage is only ~62s for 8 pages). The dominant cost is now unambiguously the **character-reference stage** (~332s in one measured 8-page run, driven by non-deterministic Gemini image latency + a 503 retry). The highest-leverage latency work left is **char-ref generation** — caching/reuse, downscaling ref images, a faster ref path, or generating fewer refs — NOT further page parallelization. Re-scope this FC's research around char refs.

**Problem / opportunity:** Total story generation time is 3-5 min for a medium (6-page) story under the FC-013 + FC-012 + FC-015 pipeline (~200-260s typical, longer on Gemini tail latency). The parent overhaul plan accepted this as a real UX cost; with the app live, it's worth investigating whether the post-FC-013 architecture lets us reclaim some of that time.

**Hypothesis to investigate (per user 2026-05-12):** with FC-013's per-character reference image framework in place, we may be able to parallelize MORE of the per-page generation than we currently do. Today's pipeline runs:

```
[story text] → [N char refs in parallel] → [title page] → [page 1] → [pages 2..N in parallel]
```

The serial bottleneck is `title page → page 1 → pages 2..N` because pages 2..N consume `page 1` as a setting reference. If character refs alone are sufficient to anchor consistency, we could potentially:

1. **Generate title page + page 1 in parallel** (both need only char refs, currently sequential — frees ~12-30s)
2. **Generate ALL content pages 1..N in parallel** using just char refs (no page-1 setting ref) — frees the entire page-1 wait (~12-30s, plus simplifies the dep graph)
3. **Combinations of 1 and 2**, plus possibly batched multi-image API calls if Gemini exposes one

**Open questions:**
- Does dropping the page-1 setting reference materially regress visual consistency across pages? (Need A/B comparison: char refs only vs char refs + page-1 setting ref.)
- Does Gemini Nano Banana 2 expose a batched / streaming API that's cheaper than N parallel `generateContent` calls?
- What's the actual end-to-end latency distribution today (p50, p95, p99) across the last N stories? (Need to instrument before optimizing.)
- Are there Cloud Run cold-start contributions worth chasing separately (min instances, concurrency tuning)?
- For long stories (8+ pages), is the bottleneck hitting Gemini's per-account QPS limit instead of any single call? (Would require backoff strategy changes, not parallelism changes.)
- If we drop the setting ref, do we need a different consistency mechanism for environmental details (recurring landmarks, color palette) that the page-1 ref currently provides for free?

**Why deep research first:** the parent plan's FC-013 work has retroactively documented latency baselines in `docs/investigations/fc-002-latency-benchmark-2026-04-28.md`. Repeating that methodology with the post-FC-015 pipeline (capture p50/p95 across 5+ stories on each candidate variant) gives us evidence for "is the latency cost worth it" instead of speculation.

---

### FC-021: GCP-side latency levers (Vertex AI endpoint, Provisioned Throughput, Cloud Run cold-start)

**Status:** Consideration — **on hold pending FC-016 Phase 3 outcome** (open 2026-05-26: review and assess only if FC-016's char-ref levers don't hit the p50 ≤ 90s / p95 ≤ 180s targets)
**Size estimate:** M (mostly measurement + config; small code touch to swap the SDK endpoint if Vertex AI wins)
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** FC-016's plan focuses on application-level levers (caching, fewer refs, downscaling, per-call timeout). It does not touch the GCP infrastructure layer — and **most GCP-side levers won't help latency** because we're network-bound on Gemini's response, not CPU/memory-bound on Cloud Run. But three GCP-side ideas are worth measuring **if FC-016 alone doesn't close the gap**, because they target the same char-ref bottleneck from a different angle (Gemini-side capacity instead of our-side call patterns).

This FC exists to capture those ideas before they get lost, NOT to compete with FC-016. The intent is: if FC-016 Phase 3 ships and we still see p95 char-ref > 180s, this FC becomes the next step.

**Three levers to evaluate (ranked by expected impact):**

1. **Vertex AI endpoint vs AI Studio API.** Same Gemini models (`gemini-3.1-flash-image-preview`) are served via two distinct GCP surfaces: AI Studio (what we use today via `@google/genai`) and Vertex AI (GCP-native, region-pinned, separate quota pool). Vertex AI in `us-central1` co-located with our Cloud Run service may show: (a) tighter tail-latency distribution (fewer 503s — our 332s outlier was driven by one ref's 503 retry); (b) better quota guarantees; (c) lower network RTT. Worth a head-to-head A/B with 5 stories per endpoint, same FC-002 methodology. Implementation cost is ~1 day — swap the SDK client init, gate behind an env flag.

2. **Vertex AI Provisioned Throughput** (if Google exposes it for Nano Banana 2 / Imagen-flavored endpoints). Reserved capacity caps the tail by guaranteeing GPU/TPU is available. Eliminates the 503-on-Gemini class of failure that drove the 331s outlier. Likely $100s/mo minimum — only justified once usage warrants it (i.e. post-launch). Investigate pricing + availability first; if not available for this model, drop this lever.

3. **Cloud Run `min-instances=1`.** Eliminates cold-start (~2-5s on first request after idle). Tiny slice of a 440s run, so it does NOT help typical-case latency. Real justification is **FC-017 reliability** (a Resume firing on a cold instance adds 2-5s to the recovery path; min=1 makes Resume responsive). ~$15/mo. Decision belongs as much to FC-017 as to this FC.

**Open questions:**

- Does Vertex AI's `gemini-3.1-flash-image-preview` exist with the same capability surface (baked-text, multimodal char refs as inputs) we depend on? Need to verify before A/B.
- Is the Vertex AI SDK (`@google-cloud/vertexai`) a drop-in for the response shape we consume in `backend/src/services/gemini.ts` (the `response.candidates[0].content.parts[].inlineData` pattern)? If not, the swap is bigger than 1 day.
- Provisioned Throughput: is it sold for image-generation models at all, or only text? (As of cutoff, primarily a text-LLM offering.)
- Does our current AI Studio quota show any rate-limiting at our usage levels? (Probably no — we're far below limits — but if yes, Vertex AI's separate quota is a free win.)
- Are there other GCP-side levers we're missing? Cloud CDN won't help inference. Memorystore vs Firestore for the FC-016 cache saves ~30ms on a 332s stage — negligible. Cloud Run gen2 vs gen1 — confirm we're on gen2, but not a latency mover.

**When to revisit:** after FC-016 Phase 3 ships and we have 20+ production stories' worth of latency data on the post-FC-016 pipeline. If p95 char-ref ≤ 180s sustained, close this FC as superseded. If still > 180s, promote Vertex AI A/B to a plan file.

---

## Completed

### FC-021: Reader orientation gate — stuck "rotate your device" overlay — Done 2026-06-22

Fixed a reported bug where the story reader blocked rendering behind a full-screen "Stories read best in landscape" overlay that never dismissed on rotation. Root cause: `isPortrait` ORed the `expo-screen-orientation` enum with `height > width` and relied on `lockAsync(LANDSCAPE)` actually rotating the UI; when the lock silently no-ops (iPad multitasking, OS portrait rotation-lock, simulators) the window never flips, the orientation listener never fires a landscape event, and the gate can never clear — trapping the user with only a Close button. Fix: always render the reader (the page-curl `Curl` is dimension-driven), detect portrait purely from `useWindowDimensions` (`height > width`), drop the unreliable orientation state + listener, and replace the blocking overlay with a small non-blocking auto-dismissing "Best read in landscape" hint. Lock is best-effort and logs on failure. Considered + rejected `UIRequiresFullScreen` (disables iPad multitasking app-wide). Adversarial review → APPROVE, no code changes required.

- **Plan:** [docs/plans/fc-021.md](plans/fc-021.md)
- **PR:** [#25](https://github.com/memon1987/ai-storybook-app/pull/25) (squash-merged as `9df56e7`)

### FC-020: Baked-in text + OCR text-repair; delete Skia overlay — Done 2026-05-24

Migrated the production image pipeline to bake narration text INTO the illustration (Gemini 3.1 Flash) with OCR detect-and-regenerate (recall ≥ 0.6 AND precision ≥ 0.75; precision catches the hallucinated-extra-text jumble), anchored by char model-sheets + cast lineup + pin-first-K canonical anchors. Fully deleted the FC-015/FC-018 Skia overlay. Stood up Vitest (22 tests). Adversarial review (REQUEST_CHANGES → CONFIRMED-CLEAN): added a char-ref image cap, tightened `isRetryableError`, fixed the timeout framing. Live-validated on an 8-page story (all pages OCR-clean, character consistency held). Latency finding: char-ref stage dominates wall-clock (~332s of 440s) → FC-017/FC-016. Breaking: pre-FC-020 stories render with a blank gap (no back-fill).

- **Plan:** [docs/plans/fc-020.md](plans/fc-020.md)
- **Investigation:** [docs/investigations/fc-019-text-paradigm-comparison-2026-05-16.md](investigations/fc-019-text-paradigm-comparison-2026-05-16.md)
- **PR:** [#21](https://github.com/memon1987/ai-storybook-app/pull/21) (squash-merged as `e3418a0`)

### FC-001: Frontend redesign (Figma v2) — Done 2026-04-24

Complete rewrite of all mobile screens to match the v2 Figma designs. Introduced 6 switchable color palettes with AsyncStorage persistence, custom tab bar, animated splash, Typeform-style 6-step create wizard, reskinned library / settings / auth screens, and a landscape story reader.

- **Plan:** [docs/plans/fc-001.md](plans/fc-001.md)
- **PR:** [#1](https://github.com/memon1987/ai-storybook-app/pull/1) (squash-merged as `669a7bc`)

### FC-011: Apple Books-style page curl reader — Done 2026-04-24

Replaced `react-native-pager-view` with a Skia + Reanimated page curl ported from William Candillon's Riveo shader. Drag-and-hold peels the current page to reveal the next. Forward curl shipped; backward turn is instant for now.

- **Plan:** [docs/plans/fc-011.md](plans/fc-011.md)
- **PR:** [#3](https://github.com/memon1987/ai-storybook-app/pull/3) (squash-merged as `53e4832`)

### FC-002: Image model cost optimization — Done 2026-04-28

Swapped `gemini-3-pro-image-preview` → `gemini-3.1-flash-image-preview` ("Nano Banana 2") on 2026-04-24 via no-plan override (`13ba5d7`). Trades ~4 points of text-in-image accuracy (94% → ~90%) for ~50% cost reduction (~$0.13 → ~$0.067 per image). Real-world latency is more variable than spec — see investigation report for the data and the keep-vs-revert reasoning.

- **Investigation:** [docs/investigations/fc-002-latency-benchmark-2026-04-28.md](investigations/fc-002-latency-benchmark-2026-04-28.md)
- **Commit:** `13ba5d7`
- **Outcome:** keep Flash; revisit if 3 of next 5 stories show > 60s avg per-page latency.

### FC-008: Security hardening — Done 2026-04-28

Externalized Firebase web config and Cloud Run API URL from hardcoded source into `EXPO_PUBLIC_*` env vars. Local dev sources them from gitignored `mobile/.env`; EAS Build sources them from per-profile `env` blocks in `mobile/eas.json`. Module-load throws an aggregated error listing every missing or placeholder var.

- **Plan:** [docs/plans/fc-008.md](plans/fc-008.md) (published retroactively + adversarial peer review)
- **PR:** [#4](https://github.com/memon1987/ai-storybook-app/pull/4) (squash-merged as `2458db2`)

### FC-014: Writing-style picker (3 voices, generic names) — Done 2026-05-11

Restored the writing-style step that was silently dropped from the create wizard during FC-001's redesign. Three structurally-distinct voices ("Bouncy Rhymes", "Gentle Refrains", "Sweet & Simple") with per-voice page-count targets (review fix); structural descriptors only — no copyrighted author names reach the LLM on the wizard path.

- **Plan:** [docs/plans/fc-014.md](plans/fc-014.md) (adversarial peer review caught two HIGH issues; both fixed before merge)
- **PR:** [#6](https://github.com/memon1987/ai-storybook-app/pull/6) (squash-merged as `76f0347`)

### FC-013: Per-character reference image pipeline — Done 2026-05-11

Added a new pipeline stage that generates one model-sheet reference image per named character before any story pages, then passes all character refs (plus the page-1 setting ref) to every page generation. Goal: tighter character consistency by using Gemini 3.1 Flash Image's multi-reference capability (up to 4 character refs / 14 total). Adds ~30-90s per story.

- **Plan:** [docs/plans/fc-013.md](plans/fc-013.md) (adversarial peer review caught 3 HIGH issues including thundering-herd retries and placehold.co URL leakage; all fixed before merge)
- **PR:** [#7](https://github.com/memon1987/ai-storybook-app/pull/7) (squash-merged as `5f86a8f`)

### FC-018: Playful, integrated narration text (FC-015 refinement) — Done 2026-05-16

Removed FC-015's opaque white rounded-rect backing behind narration text. Replaced with a 3-shadow text stack (warm halo + soft drop + tight near-glyph) on all 5 text positions, plus a soft Skia `<RadialGradient>` halo behind text on every position (alpha-fades organically past glyph edges — NOT a hard rect). Bumped baseline font weight 400 → 700, emphasis 700 → 800, registering the additional TTF weights with Skia so they actually resolve. New `haloColor` palette field (warm cream tint per palette, NEVER pure white). Backend illustration prompt also tightened with explicit NEGATIVE constraints + scoped-to-zone phrasing so Gemini stops painting literal white rectangles inside the illustration AND stops over-suppressing clouds/birds globally.

- **Plan:** [docs/plans/fc-018.md](plans/fc-018.md) (adversarial review caught 1 BLOCKER — RadialGradient nesting wrong in Skia 2.x's DSL — plus 2 HIGHs; all fixed before merge; confirmation review APPROVE-MERGE)
- **PR:** [#10](https://github.com/memon1987/ai-storybook-app/pull/10) (squash-merged as `9e1f181`)

### FC-015: Playful text placement (Skia text composition) — Done 2026-05-12

Replaced narration-baked-into-illustration with text composed inside the Skia canvas. The narration overlay lives in the same `<Group layer={Paint with RuntimeShader}>` that the page-curl shader operates on, so the curl deforms image+text as one composite — no fade hack, no coordinate translation, real fonts, zero spelling errors. Per-page LLM-chosen `textPosition` (`top` / `bottom` / `left` / `right` / `center-overlay`); writing style picks the font (Bouncy → Baloo 2, Gentle → Nunito, Sweet & Simple → Quicksand). Optional `soundEffects[]` are short stylized words still rendered in-image; optional `emphasizedWords[]` are highlighted in the overlay. Backwards-compatible: pre-FC-015 stories' baked-in text still shows through.

- **Plan:** [docs/plans/fc-015.md](plans/fc-015.md) (adversarial peer review caught 2 HIGH issues — Gemini occasionally drops `textPosition` triggering a textless page; uncaught Skia paragraph throws crashing the reader — plus 4 MEDIUM; all fixed before merge; confirmation review APPROVE-MERGE)
- **PR:** [#9](https://github.com/memon1987/ai-storybook-app/pull/9) (squash-merged as `262c230`)

### FC-012: Title page generation — Done 2026-05-11

Adds a dedicated cover image to every story, generated after FC-013's character refs (so cover characters match in-book characters). Surfaced via separate `titlePageImageUrl` + `titlePage` fields on the story (Option 2; cleaner than the parent plan's pages[0] sentinel). Library StoryCard uses it as the thumbnail; reader prepends it as a synthesized page-0 with "Cover" label.

- **Plan:** [docs/plans/fc-012.md](plans/fc-012.md) (Option-2 deviation documented; first adversarial review attempt stalled at watchdog, tighter retry returned APPROVE with only LOW nits)
- **PR:** [#8](https://github.com/memon1987/ai-storybook-app/pull/8) (squash-merged as `3610bac`)
