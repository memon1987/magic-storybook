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

### FC-018: Playful, integrated narration text (FC-015 refinement)

**Status:** Plan published
**Size estimate:** M
**Owner:** Zeshan / Claude
**Plan file:** `docs/plans/fc-018.md`

**Problem / opportunity:** FC-015's translucent white backing rect behind narration text reads as a UI panel slapped on top of the illustration, not typography integrated into the page. User wants a Dr. Seuss / Pout-Pout Fish feel. Plan: drop the rect entirely; replace legibility with a multi-shadow text stack (warm halo + drop + tight) and a soft radial halo only for `center-overlay` (the worst-case position). Also tighten the illustration prompt's negative-space contract so Gemini stops painting literal white rectangles.

**Open questions:**
- Should the radial halo extend beyond `center-overlay` to all positions if legibility issues emerge?
- Font weight uniform across writing styles or per-voice?

---

### FC-017: Story generation reliability — request resumes / async job model

**Status:** Consideration
**Size estimate:** L (likely architecture refactor)
**Owner:** unassigned
**Plan file:** not yet

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

**Status:** Consideration
**Size estimate:** M-L (research first, then implementation)
**Owner:** unassigned
**Plan file:** not yet (research must precede a plan)

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

## Completed

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

### FC-015: Playful text placement (Skia text composition) — Done 2026-05-12

Replaced narration-baked-into-illustration with text composed inside the Skia canvas. The narration overlay lives in the same `<Group layer={Paint with RuntimeShader}>` that the page-curl shader operates on, so the curl deforms image+text as one composite — no fade hack, no coordinate translation, real fonts, zero spelling errors. Per-page LLM-chosen `textPosition` (`top` / `bottom` / `left` / `right` / `center-overlay`); writing style picks the font (Bouncy → Baloo 2, Gentle → Nunito, Sweet & Simple → Quicksand). Optional `soundEffects[]` are short stylized words still rendered in-image; optional `emphasizedWords[]` are highlighted in the overlay. Backwards-compatible: pre-FC-015 stories' baked-in text still shows through.

- **Plan:** [docs/plans/fc-015.md](plans/fc-015.md) (adversarial peer review caught 2 HIGH issues — Gemini occasionally drops `textPosition` triggering a textless page; uncaught Skia paragraph throws crashing the reader — plus 4 MEDIUM; all fixed before merge; confirmation review APPROVE-MERGE)
- **PR:** [#9](https://github.com/memon1987/ai-storybook-app/pull/9) (squash-merged as `262c230`)

### FC-012: Title page generation — Done 2026-05-11

Adds a dedicated cover image to every story, generated after FC-013's character refs (so cover characters match in-book characters). Surfaced via separate `titlePageImageUrl` + `titlePage` fields on the story (Option 2; cleaner than the parent plan's pages[0] sentinel). Library StoryCard uses it as the thumbnail; reader prepends it as a synthesized page-0 with "Cover" label.

- **Plan:** [docs/plans/fc-012.md](plans/fc-012.md) (Option-2 deviation documented; first adversarial review attempt stalled at watchdog, tighter retry returned APPROVE with only LOW nits)
- **PR:** [#8](https://github.com/memon1987/ai-storybook-app/pull/8) (squash-merged as `3610bac`)
