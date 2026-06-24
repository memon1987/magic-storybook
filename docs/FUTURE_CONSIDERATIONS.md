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

### FC-024: Stand up a mobile test runner (vitest / jest-expo)

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** The `mobile/` package has **zero** test infrastructure — no `test` script, no vitest/jest, no test files (verified 2026-06-22 during FC-022). Pure logic that's easy to get wrong currently ships verified only by manual walkthrough: e.g. FC-022's `readerPageLabel` page-counter helper (`components/PageCurl/paging.ts` — cover/end-page offset math), the `services/api.ts` auth-token interceptor, and `useAuth` state transitions. A runner would let us unit-test extracted pure helpers immediately and add component tests for the reader over time. (Backend already uses Vitest — see FC-020.)

**Open questions:**
- vitest (consistent with backend, fast) vs jest-expo (official Expo preset, better RN/Skia/Reanimated mocking out of the box)?
- Unit-only to start, or also component tests via `@testing-library/react-native` given the Skia/Reanimated native deps that need mocking?
- CI wiring: there is **no GitHub Actions workflow** in this repo yet (noted during FC-023). Stand one up to gate PRs on `tsc` + tests, or run locally only at first?
- First targets once a runner exists: `readerPageLabel`, the `api.ts` interceptor, `useAuth` reducer logic.

---

### FC-026: Responsive layout Phase 1 — critical device-layout bugs

**Status:** Executing
**Size estimate:** M
**Owner:** Zeshan
**Plan file:** [docs/plans/fc-026.md](plans/fc-026.md)

**Problem / opportunity:** On iPhone 17 Pro Max two screens render wrong because layout is hardcoded to one form factor. (1) The Library "zooms into" just the first two stories in landscape — `mobile/app/(tabs)/index.tsx` hardcodes `numColumns={2}` with `flex:1` cells whose cover is `aspectRatio:3/4`, so doubling the row width doubles card size and only the first row fits. (2) The reader clips baked-in narration text — `components/PageCurl/Curl.tsx` draws every image `fit="cover"`, cropping edges, and landscape device ratios span ~1.33:1 (iPad) to ~2.16:1 (Pro Max) with no pinned backend aspect ratio. Broader goal: render well across the full Apple device matrix, both orientations.

**Scope (Phase 1):** add root `SafeAreaProvider`; new minimal `useResponsive()` hook (+ pure `computeGrid`); reactive library grid; reader → `fit="contain"` with a blurred ambient backdrop (guarantees no clipped text on every device *and* every existing baked image). iPad/all-screen polish deferred to **FC-027**; optional backend aspect-ratio pin to **FC-028**.

---

### FC-027: Responsive layout Phase 2 — iPad / landscape polish

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** After FC-026 fixes the two critical bugs, the rest of the app still assumes a phone form factor on iPad. Finish `useResponsive` (`scale`, `contentMaxWidth`, `deviceClass`); add a `ResponsiveContainer` (center + max-width) for login/register/settings so cards/rows don't stretch edge-to-edge; fix `create.tsx` art-style grid `width:'31%'` (3-up phone → 4-up tablet) and cap the `'70%'` generating overlay; optional notch gutters on reader top/bottom bars.

---

### FC-028: Pin backend image aspect ratio (optional)

**Status:** Consideration
**Size estimate:** S
**Owner:** unassigned
**Plan file:** not yet

**Problem / opportunity:** With FC-026's reader `contain`, images letterbox by the gap between the generated ratio and the device ratio. Pinning `config.imageConfig.aspectRatio` (~16:9, verified against the installed `@google/genai` + `gemini-3.1-flash-image-preview` allowed ratios) on all four image calls in `backend/src/services/gemini.ts` would shrink those bands for **new** stories. Does not affect existing stories (baked images frozen) — the mobile `contain` change already covers those, which is why this is optional polish, not a fix.

---

### FC-029: Social sign-in — Google + Apple

**Status:** iOS code+config+build-fixes on `main` (feat `0086f73`, lazy-load #35, OAuth IDs #37, lockfile #39, static-frameworks #40). Simulator build `b8914890` ✓. TestFlight build + on-device verify owner-driven (queued 2026-06-23); Android deferred. See plan Execution.
**Size estimate:** M
**Owner:** Zeshan
**Plan file:** [docs/plans/fc-029.md](plans/fc-029.md)

**Problem / opportunity:** The login screen's "Continue with Google" button was a `Alert.alert('Coming soon')` stub; register had no social option. Social sign-in lowers signup friction. We're on the Firebase **Web** JS SDK v11, whose `signInWithPopup`/`signInWithRedirect` don't work in React Native — so each provider acquires a token natively, then exchanges it via `signInWithCredential`. Google uses the native account sheet (`@react-native-google-signin/google-signin`); Apple uses `expo-apple-authentication` with a SHA-256 nonce. Because offering Google on iOS triggers App Store Guideline 4.8, **Sign in with Apple ships in the same FC** (iOS-only) so the next prod submission is compliant. Sessions persist via the existing `getReactNativePersistence` init (PR #32). Console setup (OAuth client IDs, provider enablement, Apple capability, Android SHA-1) is a prerequisite handoff; code lands with placeholder client IDs.

---

### FC-033: Firestore emulator + integration tests for FC-017 concurrency-critical paths

**Status:** Consideration
**Size estimate:** M
**Owner:** unassigned
**Plan file:** not yet
**Parent FC:** FC-017
**Source:** R1 MEDIUM-3 from [docs/investigations/fc-017-retrospective-2026-06-23.md](investigations/fc-017-retrospective-2026-06-23.md)

**Problem / opportunity:** FC-030 ships with light-weight mocked-Firestore tests for the corruption-hotfix paths. The deeper distributed-systems guarantees (claimLock contention under N concurrent workers, sweep race window narrowing, heartbeat lifecycle under fake-clock pressure) need a real Firestore emulator. Estimated ~1 day of test infra. Defer until the next time a concurrency regression surfaces or before any further FC touches the worker state machine.

---

### FC-034: Cloud Monitoring dashboard + log-based metrics for FC-017 instrumentation

**Status:** Consideration
**Size estimate:** S-M
**Owner:** unassigned
**Plan file:** not yet
**Parent FC:** FC-017
**Source:** R3 M-2 from [docs/investigations/fc-017-retrospective-2026-06-23.md](investigations/fc-017-retrospective-2026-06-23.md)

**Problem / opportunity:** Phase 1's `emitStageEvent`/`emitCallEvent` structured JSON lands in Cloud Logging via `console.log(JSON.stringify(...))` and is never read. FC-032 ships *failure*-detection alerts but not *latency*-distribution charts. A Cloud Monitoring dashboard with log-based-metrics extracting `latencyMs` by stage + `outcome=failure` counts by stage closes the gap between "instrumentation captured" and "instrumentation observed." Defer until the first incident triage where the absence of a dashboard would have made things faster.

---

### FC-035: Reader — decouple tap from navigation + backward page-curl

**Status:** Executing
**Size estimate:** M
**Owner:** Zeshan
**Plan file:** [docs/plans/fc-035.md](plans/fc-035.md)

_(Implemented/reviewed under the label "FC-029"; renumbered to FC-035 after a concurrent session merged its own FC-029 — Google/Apple social sign-in — first. Branch `feature/fc-029-reader-tap-backward-curl` / PR #33 / git history keep the old label.)_

**Problem / opportunity:** In the reader, tapping was overloaded — it toggled the info bars AND navigated via hard-coded zones (left 25% = prev, right 25% = next, center 50% = toggle), so a tap meant to reveal the bars frequently landed in an edge zone and accidentally flipped the page (reported on build 11). Fix: (1) a tap anywhere only toggles the controls — never navigates; (2) add a backward page-curl swipe (the curl was forward-only). Reuses the existing GLSL shader for backward (curl-layer top = previous image, `pointer` 0→width sweeps the fold left→right so the previous page enters from the left). Two files: `Curl.tsx`, `read.tsx`.

---

## Completed

### FC-032: FC-017 ops floor baseline — Done 2026-06-24

Sub-FC of FC-017. Closes R3 from the 2026-06-23 system-level retrospective ("operational posture surrounding FC-017 is essentially zero"). Two repo-side changes: `cloudbuild.yaml` gains a `npm ci`+`npm test` CI test gate (broken tests no longer deploy) and a pinned `--max-instances=20`/`--min-instances=0` (was a manual annotation that next deploy would have silently regressed to default 1000). Nine runbooks under `docs/runbooks/` cover the most-likely operational scenarios (sweep failure, secret rotation, Cloud Run rollback, stuck-story triage, manual resume, Firestore restore, build failures, OOM response, recreate-alerting). Out-of-band gcloud actions also done: Firestore PITR (7-day window) + daily backup schedule, Cloud Scheduler retry config (3 attempts, 30s-5m backoff), email notification channel, 2 log-based metrics (`sweep_failures`/`storybook_api_errors`), 2 monitoring alert policies (sweep-orphans-error + storybook-api-error-rate). Cloud Build failure alert documented in `recreate-alerting.md` with the recipe but NOT YET CREATED. OIDC migration for sweep auth deferred to a future FC. Adversarial review caught 2 BLOCKERs (bogus `gcloud firestore documents` syntax in two runbooks; `mint-spike-token.js` referenced but untracked) and 4 HIGHs (Scheduler-pause-during-rotation, capture-prior-version-before-disable, OOM filter wrong, cold-start caveat in rollback); all fixed → CONFIRMED-CLEAN.

- **Plan:** [docs/plans/fc-032.md](plans/fc-032.md)
- **PR:** [#38](https://github.com/memon1987/ai-storybook-app/pull/38) (squash-merged as `efe8784`)
- **Parent FC:** FC-017 (`docs/plans/fc-017.md`)
- **Investigation:** [docs/investigations/fc-017-retrospective-2026-06-23.md](investigations/fc-017-retrospective-2026-06-23.md)

### FC-031: FC-017 mobile hardening — Done 2026-06-23

Sub-FC of FC-017. Closes R2 + R4 user-visible residuals from the 2026-06-23 system-level retrospective. Library `useQuery` now polls every 15s while any non-terminal row exists (was: stale forever — directly contradicted the FC-017 plan's user promise). `navigatedRef` keyed on `(id, attempt)` (was: stranded the user on /generating after a Resume-then-success cycle). Initial `progress` field populated synchronously at doc-create (eliminates the silent-queued window). Retry budget: mobile reads `attempt` and caps Resume at 3; safety-blocked failures suppress Resume entirely + show "Create a new story" CTA (closes the ~$0.50-$1.10/Resume cost-loop). Adversarial review caught a HIGH-1 reintroduction of the FC-025 B-4 nested-`serverTimestamp` footgun (sentinel inside a map literal in the initial-progress write); fixed by splitting `set()` from a dot-notation `update()` and adding `'queued'` to GenerationPhase as the honest pre-claim value. CONFIRMED-CLEAN. Mobile changes ship on the next EAS build.

- **Plan:** [docs/plans/fc-031.md](plans/fc-031.md)
- **PR:** [#36](https://github.com/memon1987/ai-storybook-app/pull/36) (squash-merged as `47e6b00`)
- **Parent FC:** FC-017 (`docs/plans/fc-017.md`)
- **Investigation:** [docs/investigations/fc-017-retrospective-2026-06-23.md](investigations/fc-017-retrospective-2026-06-23.md)

### FC-030: FC-017 corruption-class hotfix — Done 2026-06-23

Sub-FC of FC-017. Closes the duplicate-pages-in-subcollection corruption class found by R1 BLOCKERs 1-3 of the 2026-06-23 system-level retrospective. Four defense-in-depth changes: (1) **deterministic page-doc IDs** at [worker.ts:387](https://github.com/memon1987/ai-storybook-app/blob/main/backend/src/services/worker.ts#L387) (idempotency floor — closes the corruption class under ANY double-execution path including the ones we haven't found yet); (2) **sweep transactional re-read** with per-doc `runTransaction` + `.limit(100)` (closes the sweep ↔ stale-lock-takeover race); (3) **SIGTERM-aware finalize** (transaction refuses to overwrite `complete`/`failed`); (4) **`fireWorkerInBackground` transactional catch** with `workerId !== WORKER_ID` predicate (closes UX flicker class; preserves own-process recovery on transient catch-write failure). All three transactional predicates exported as pure-ish functions so tests exercise production code, not inline copies. 17 new behavior tests against an in-memory Firestore double; full suite 51→68 passing. Adversarial review caught HIGH-1 (tests reimplementing predicates) and MEDIUM-1 (bg-catch refusing own-process recovery); both fixed → CONFIRMED-CLEAN.

- **Plan:** [docs/plans/fc-030.md](plans/fc-030.md)
- **PR:** [#34](https://github.com/memon1987/ai-storybook-app/pull/34) (squash-merged as `cf4c362`)
- **Parent FC:** FC-017 (`docs/plans/fc-017.md`)
- **Investigation:** [docs/investigations/fc-017-retrospective-2026-06-23.md](investigations/fc-017-retrospective-2026-06-23.md)

### FC-017: Story generation reliability — request resumes / async job model — Done 2026-06-23

The full four-phase rollout shipped over PR #23 (Phase 1 instrumentation), PR #26 + FC-025 (Phase 2 resumability), and PR #29 (Phase 3 async 202-ACK + Phase 4 mobile snapshot UI + orphan sweep). What was a 3-5 min synchronous HTTP request that lost ~80% of the work on instance death is now a 202-ACK + Firestore-driven worker: mobile gets `{ storyId }` in ~100-500ms, navigates to `/story/[id]/generating` which subscribes to the Firestore doc, and watches `progress.message` + the determinate bar update through char-ref → title → pages → save. The worker writes per-phase checkpoints (`completedPageUrls`, `castAttempted`, `titleAttempted`) so a resumed run only re-does what's missing. `LockHeldError` + transactional `claimLock` + heartbeat-based stale-lock take-over (90s) prevent double-runs across Cloud Run instances. `--no-cpu-throttling` (pinned in `cloudbuild.yaml`) keeps the worker running after the 202 ships. A Cloud Scheduler job hits `POST /api/admin/sweep-orphans` every 10 min (bearer-token + `crypto.timingSafeEqual`, 5-min orphan threshold) and marks stale generating/queued stories `failed:'orphaned'` so the UI can surface a Resume button instead of stuck-spinning forever. **Two-round adversarial review** per CLAUDE.md stakes-calibration on each phase — Round 2 of Phase 2 caught a 7th BLOCKER (`FieldValue.serverTimestamp()` nested-map footgun) Round 1 missed; FC-025 was opened as a sub-FC to track the consolidated remediation. PR #29 review found 4 BLOCKERs (cloudbuild CPU throttling, generic-error stuck-queued, missing composite indexes, missing Firestore rules) + a `pickClientFields` schema-leak HIGH; all fixed pre-merge. **Closes:** the 2026-05-12 "instance died at 80%" failure mode; the silent-success bug (backend kept running to 3600s past the 600s axios timeout); the lack of per-page progress visibility. **Out of scope:** push notifications when a story finishes (defer); per-story Cloud Tasks/separate worker service (the in-process Cloud Run worker with `--no-cpu-throttling` is sufficient for the current load profile).

- **Plan:** [docs/plans/fc-017.md](plans/fc-017.md)
- **Sub-FC:** [FC-025](plans/fc-025.md) — Phase 2 adversarial-review remediation (a process artifact, not a separate feature)
- **PRs:** [#23](https://github.com/memon1987/ai-storybook-app/pull/23) (Phase 1 — instrumentation, `f5f9cb5`), [#26](https://github.com/memon1987/ai-storybook-app/pull/26) (Phase 2 + FC-025, `ece2458`), [#29](https://github.com/memon1987/ai-storybook-app/pull/29) (Phase 3 + 4, `fc8944a`)
- **Out-of-band deploys (2026-06-23):** `firebase deploy --only firestore` (rules + indexes), `gcloud secrets create sweep-auth-token` → Cloud Run revision `00123-h75`, `gcloud scheduler jobs create http sweep-orphans --schedule="*/10 * * * *"`.
- **Process lesson:** the FC-025 sub-FC pattern (open a tracking FC when an adversarial review on a closed PR generates a multi-stage remediation) worked — it kept the parent FC plan readable while still recording the remediation in the FC index. Use again for similar future cases.

### FC-025: FC-017 Phase 2 (PR #26) adversarial-review remediation — Done 2026-06-22

Sub-FC for FC-017 Phase 2. After PR #26 was opened without the CLAUDE.md-required adversarial review, two independent post-hoc reviews (`/code-review max` distributed-systems lens + a fresh senior-SRE Firestore-semantics persona, no shared context) converged on REQUEST_CHANGES with the same 6 BLOCKER-class bugs (lock re-entry race, placeholder URL lock-in, heartbeat race with batch.commit, catch-vs-finally lock window, failureReason leak, null-as-failure infinite retry); Round 2 surfaced a 7th BLOCKER-tier `FieldValue.serverTimestamp()` nested-map footgun Round 1 missed. FC-025 plan consolidated 6 BLOCKERs + 10 HIGHs + 6 MEDIUMs + 6 LOWs across 6 sequenced stages, all shipped in fix commit `9e38aed` on the same PR branch. Confirmation review per CLAUDE.md returned CONFIRMED-CLEAN (all 20 contract items verified individually, zero STILL-BROKEN, no merge-blocking regressions). PR #26 squash-merged as `ece2458` with both FC-017 Phase 2 + FC-025 remediation in one commit.

- **Plan:** [docs/plans/fc-025.md](plans/fc-025.md)
- **PR:** [#26](https://github.com/memon1987/ai-storybook-app/pull/26) (squash-merged as `ece2458`)
- **Parent FC:** FC-017 Phase 2 (`docs/plans/fc-017.md`)
- **Process lesson:** the CLAUDE.md adversarial-review gate caught BLOCKER-class data-corruption bugs that would otherwise have shipped to production. Two-reviewer stakes-calibration for this class of work (distributed locks + canonical Firestore writes) validated — Round 2 found a bug Round 1 missed.

### FC-022: Reader "The End" — dedicated end page instead of last-page overlay — Done 2026-06-22

The reader rendered the "The End" card as a full-screen dark scrim the instant the user reached the last page, covering the final story page and making it unreadable. Fixed by appending a synthetic image-less "The End" page (mirroring the synthesized cover at page 0): the user turns to it via the normal page-curl, the Curl paints it solid black, and the card + confetti now trigger on `isEndPage` — so the last *story* page has no overlay and is fully readable. Extracted the cover/end-aware page-counter logic into a pure helper (`components/PageCurl/paging.ts → readerPageLabel`); `usePageImages` coerces empty `imageUrl` → null so the end page never hits Skia's `useImage('')`. Rejected Option 2 (over-scroll trigger) — the Curl only emits forward-commit events, so it would require a new undiscoverable gesture. Adversarial review → APPROVE, no code changes required. `mobile/` has no test runner → follow-up **FC-024** filed.

- **Plan:** [docs/plans/fc-022.md](plans/fc-022.md)
- **PR:** [#27](https://github.com/memon1987/ai-storybook-app/pull/27) (squash-merged as `c5d5456`)

### FC-023: Reader orientation gate — stuck "rotate your device" overlay — Done 2026-06-22

_(Originally filed as FC-021; renumbered to FC-023 to resolve a collision with the pre-existing "FC-021: GCP-side latency levers" consideration. PR #25 / git history still reference the old "FC-021" label.)_

Fixed a reported bug where the story reader blocked rendering behind a full-screen "Stories read best in landscape" overlay that never dismissed on rotation. Root cause: `isPortrait` ORed the `expo-screen-orientation` enum with `height > width` and relied on `lockAsync(LANDSCAPE)` actually rotating the UI; when the lock silently no-ops (iPad multitasking, OS portrait rotation-lock, simulators) the window never flips, the orientation listener never fires a landscape event, and the gate can never clear — trapping the user with only a Close button. Fix: always render the reader (the page-curl `Curl` is dimension-driven), detect portrait purely from `useWindowDimensions` (`height > width`), drop the unreliable orientation state + listener, and replace the blocking overlay with a small non-blocking auto-dismissing "Best read in landscape" hint. Lock is best-effort and logs on failure. Considered + rejected `UIRequiresFullScreen` (disables iPad multitasking app-wide). Adversarial review → APPROVE, no code changes required.

- **Plan:** [docs/plans/fc-023.md](plans/fc-023.md)
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
