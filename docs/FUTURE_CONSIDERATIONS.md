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

### FC-015: Playful text placement (Skia text composition)

**Status:** Plan published
**Size estimate:** M-L
**Owner:** Zeshan / Claude
**Plan file:** `docs/plans/fc-015.md`

**Problem / opportunity:** Story narration is currently baked into illustrations and pinned to a bottom band. Text feels static, ~10% of words are subtly mis-spelled by Gemini, and font choice can't match the writing-style picker (FC-014). Composing text *inside* the Skia canvas — in the same Group as the page image so the page-curl shader treats both as one surface — gives us pixel-perfect typography, varied placement, and zero spelling errors, without breaking the Apple Books-like pre-read affordance the curl was built for.

**Open questions:**
- Will Gemini actually vary `textPosition` across pages, or default to `top`/`bottom` reflexively?
- SkParagraph word-wrap quality on long emphasis runs at landscape phone widths?

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

### FC-012: Title page generation — Done 2026-05-11

Adds a dedicated cover image to every story, generated after FC-013's character refs (so cover characters match in-book characters). Surfaced via separate `titlePageImageUrl` + `titlePage` fields on the story (Option 2; cleaner than the parent plan's pages[0] sentinel). Library StoryCard uses it as the thumbnail; reader prepends it as a synthesized page-0 with "Cover" label.

- **Plan:** [docs/plans/fc-012.md](plans/fc-012.md) (Option-2 deviation documented; first adversarial review attempt stalled at watchdog, tighter retry returned APPROVE with only LOW nits)
- **PR:** [#8](https://github.com/memon1987/ai-storybook-app/pull/8) (squash-merged as `3610bac`)
