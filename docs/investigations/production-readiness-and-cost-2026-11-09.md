# Production readiness and cost per story — investigation (2026-11-09)

**Backs:** FC-049 (production readiness epic). **Prompted by:** the 2026-11-09 outage (Gemini prepaid
credits depleted, HTTP 402, no alert) found while renewing the TestFlight beta (FC-045), and the
owner's intent to publish broadly on the App Store with paid subscriptions.

**Sources:** production Firestore + Cloud Storage aggregates (counts only), Google / Apple / FTC
documentation read on 2026-11-09 (URLs at the end), and the repo's earlier benchmarks (FC-002,
FC-019/020). Prices are list prices on the day; every figure that came from a third party or a
summarized page is marked *(unverified)*. Nothing here is legal advice.

---

## 0. Findings that change the plan

1. **The storybook already has its own GCP project.** `ai-storybook-app-2025` holds Cloud Run,
   Firestore, Cloud Storage and the Gemini key. What it shares with the options-wheel app is the
   **billing account** (`My Billing Account`, `010DFF-790C51-1C675E`), and with it the prepaid
   Gemini credit pool, the Gemini tier spend caps, and budgets. The fix is a dedicated billing
   account (a link operation), not a project migration. A project migration would break Firebase
   Auth users and buy nothing.
2. **Google's terms prohibit using Gemini in apps for or accessible to under-18s — on both
   surfaces.** Gemini API terms (effective 2026-03-23), "Age Requirements": API clients may not be
   "directed towards or … likely to be accessed by individuals under the age of 18." Google Cloud
   Service Specific Terms §20(d) (covers Vertex AI): "Customer will not, and will not allow End
   Users to, use a Generative AI Service as part of a website, Customer Application, or other
   online service that is directed towards or is likely to be accessed by individuals under the
   age of 18." No exception, consent route or education carve-out exists on either page; §20(f)
   allows suspension or termination on suspicion. **Moving to Vertex does not fix this.** The
   users are parents and generation is server-side, which is an argument, but a storybook app is
   hard to call "not likely to be accessed by" children. This needs counsel and a written answer
   from Google, and it makes the AI provider an open decision (OpenAI publishes an "Under 18 API
   guidance" with conditions rather than a ban; other providers' terms were not checked).
3. **Today's cost per story is ~$0.75, and ~85 % of it is image output.** The FC-002 estimate
   ($0.40 for 6 pages) counted pages only; production generates 10.8 images per full story.
4. **The realistic floor with the current product (baked-in text, interactive generation) is about
   $0.35–0.40 per medium story**, via model choice, thinking level, and fewer reference images. A
   non-interactive batch tier halves that. Going below ~$0.20 interactively means revisiting the
   baked-text decision (FC-019/020), which would let pages come from much cheaper models.

---

## 1. What production data says

Firestore `stories` (read-only aggregate, 2026-11-09) and bucket `ai-storybook-app-2025-images`:

| Metric | Value |
|---|---|
| Stories / distinct users | 123 / 9 (2026-01 → 2026-09) |
| Completed | 102; **21 stuck in `generating`** (all pre-June, before the FC-017 orphan sweep) — housekeeping |
| Length mix | short (4 pages) 45, medium (6) 60, long (8) 18 — note: 4/6/8, not the 5/8/12 in `CLAUDE.md` |
| Characters per story | 2 in 66 stories, 3 in 6, 4 in 1 (50 pre-FC-013 stories have none) |
| Generated images per full story (≥5 pages + cover, n=55) | **10.8**: 2.13 character sheets + 1 cast lineup + 1 cover + pages |
| Stored objects | 874 (564 pages, 158 character refs, 76 covers, 75 cast); 0.74 GB total; pages ≈ 1 MB JPEG |
| OCR regeneration rate | not measurable (logs expired; stage events only recorded `attempts: 1`). Only datum: 6/6 first-attempt passes in the FC-019 live check. **Assumed 10 % below.** |

Implications: storage and egress are rounding errors (≈ 10 MB per story, $0.0002/month, ~$0.001
per full read); the cost is the number of image generations × unit price.

## 2. Cost per story — model, validated against the composition above

Medium story, 2 characters: 2 char sheets + 1 cast + 1 cover + 6 pages = **10 images**, plus one
regeneration in ten pages. Reference images attached per call (as `buildPageContents` does):
page 1 = 3, page 2 = 4, pages 3–6 = 5 each, cover = 2 → **29 reference inputs × 1,120 tokens**
(Google's published figure per input image) + ~1.5K tokens of prompt per call ≈ 47K input tokens.

| Line item | Nano Banana 2 (`gemini-3.1-flash-image`, today's pricing) | Nano Banana 2.1 (`gemini-nano-banana-2.1`, FC-045 target) | NB 2.1 + `thinkingLevel: minimal` (needs SDK upgrade, FC-042) |
|---|---|---|---|
| Image output (10 × 1K) | 10 × $0.067 = **$0.67** | 10 × $0.0336 = **$0.34** | $0.34 |
| Image/prompt input tokens | 47K × $0.50/1M = $0.02 | 47K × $1.50/1M = $0.07 | $0.07 |
| Thinking tokens (billed at text-output rate) | ~$0.01 (default `minimal`, $3/1M) | **$0.03–0.15** (default `medium`, $7.50/1M; count unpublished — assume ~1,000/img = $0.075) | ~$0.015 |
| Regenerations (0.6 image) | $0.04 | $0.03 | $0.03 |
| Cloud Vision OCR (6.6 calls × $1.50/1K) | $0.01 | $0.01 | $0.01 |
| Story text + both moderation gates (`gemini-3-flash-preview`) | $0.02 | $0.02 | $0.02 |
| Cloud Run (~4 min, 1 vCPU / 2 GiB, CPU always on) | $0.01 | $0.01 | $0.01 |
| Storage / egress | <$0.01 | <$0.01 | <$0.01 |
| **Total, medium (6 pages)** | **≈ $0.78** | **≈ $0.55 (0.50–0.63)** | **≈ $0.49** |
| Short (4 pages, 8 images) | ≈ $0.63 | ≈ $0.45 | ≈ $0.40 |
| Long (8 pages, 12 images) | ≈ $0.93 | ≈ $0.65 | ≈ $0.58 |

Cross-check: the owner's "$0.70–1.30 per story" matches the first column for medium/long stories.
The FC-045 live-verification run will replace the assumed thinking-token and regeneration figures
with measured ones (`thoughtTokens`, `ocrPassed` telemetry added in FC-045).

## 3. Levers to reduce cost per story (medium story, from the $0.49 NB 2.1 + minimal baseline)

| # | Lever | Saves | Trade-off / evidence needed |
|---|---|---|---|
| L1 | **Move to NB 2.1** (FC-045, in flight) | −$0.33 vs today ($0.78 → $0.55) | Live verification gates on text fidelity, latency, shape |
| L2 | **`thinkingLevel: minimal`** on the image model (FC-042 SDK upgrade) | −$0.02 to −$0.13 depending on measured thinking tokens | Measure `thoughtTokens` first; minimal may lower text accuracy — compare OCR pass rate |
| L3 | **Cast lineup only — drop per-character sheets** (crop the cast sheet for per-character refs if needed; the lineup already shows every character on white at relative scale) | −2 images and −13 reference inputs ≈ **−$0.09** → ≈ $0.40 | FC-013 showed sheets help consistency, but the cast lineup (FC-019/020) came later and may make them redundant. Needs a consistency bake-off (10 stories, blind rating) |
| L4 | **Reuse the child's character sheet across stories** (cache per user + description hash; FC-016 already sketched this) | −1 image on repeat stories ≈ −$0.04, and better cross-book consistency (a product feature) | Invalidate when the description changes |
| L5 | **Implicit prompt caching of references** — put references first and byte-identical so Gemini's implicit cache hits (≥4,096-token prefix; cached input $0.15/1M on Vertex vs $1.50) | up to −$0.05 | Only documented for text models and as "implicit: supported" for image models; measure cache-hit tokens |
| L6 | **Fewer anchors** (1 prior page instead of 2) | ≈ −$0.01 | Consistency risk; not worth it alone |
| L7 | **Lite image model (`gemini-3.1-flash-lite-image`) for sheets and cast** (no baked text, no reference inputs on those calls) | $0 at NB 2.1 prices (same $0.0336); input/thinking slightly cheaper | Skip unless NB 2.1 prices rise |
| L8 | **Server-side text overlay as the OCR-failure fallback** instead of regenerating | −$0.03 and −10–20 s latency per failed page | Quality: FC-019 chose baked text over overlay for placement quality; a *fallback-only* overlay is a smaller concession |
| L9 | **Batch API tier** ("your book is ready tomorrow"): −50 % on all image calls, 1K only | ≈ **$0.22** per medium story | 24 h target, up to 72 h queue on Vertex; a different product promise, viable as a cheaper plan |
| L10 | **Vertex Flex PayGo** (synchronous, −50 %, ≤30 min) | −50 % on image calls | Preview; supports `gemini-3.1-flash-image` and Lite, **not NB 2.1** |
| L11 | **Decouple text from images** (text layer rendered by the app or server; pages carry no text) | Removes OCR, regenerations and the text-accuracy constraint; pages could then come from the cheapest capable model (e.g. FLUX 3 Klein $0.009/img *(unverified)*, Lite $0.0336) → **≈ $0.10–0.25 per story** | Reverses the FC-019/020 product decision (overlay text looked worse); character consistency with references must be re-tested on any new model. Largest lever by far; a product decision, not an optimization |

Not worth doing: lower resolution (0.5K exists only on `gemini-3.1-flash-image` at $0.045, more
than NB 2.1 at 1K); Provisioned Throughput (≈ $2,000–2,700/month per GSU, ≈ $0.035/image at 100 %
utilization — no cheaper than pay-as-you-go); switching image provider on price alone (OpenAI
gpt-image-2 medium ≈ $0.053/img *(unverified table)*, 1.6× NB 2.1; its batch price ≈ $0.027).

**Realistic targets:** interactive medium story **$0.35–0.40** (L1 + L2 + L3, with L4 on
repeats); short **≈ $0.30**; batch tier **≈ $0.20**; L11 **$0.10–0.25**.

### What that means for pricing

Apple takes 15 % (Small Business Program, must enroll; ≤ $1M prior-year proceeds) or 30 %.

| Plan | Net to you | Stories/month at $0.40 COGS for 30 % / 50 % COGS ratio |
|---|---|---|
| $4.99/month | $4.24 | 3 / 5 |
| $9.99/month | $8.49 | 6 / 10 |
| $2.99 per book | $2.54 | 1 (COGS 16 %) |

Market context *(third-party listings, 2026-11-09)*: CreateStory.ai $5.99/mo for 1 story to
$49.99/mo for 10 (≈ $5–10 per 16-page story); Childbook.ai $19/mo for 20 books with 100
illustration credits (the credits are the binding cap, ≈ 5 images/book); Oscar Stories $4.99/mo
"unlimited" but text/audio-first; Wonderbly print books $35–45. Fully illustrated competitors cap
stories per month; "unlimited" is only safe with a hard per-user cap. **The owner's target price
per story is the missing input for choosing between L3/L9/L11.**

## 4. Where to buy inference (item 2)

### Gemini Developer API (today) vs Vertex AI

| | Developer API (AI Studio key) | Vertex AI ("Gemini Enterprise Agent Platform") |
|---|---|---|
| Prices for the same model IDs | identical on the global endpoint | identical (+10 % on regional endpoints for some models) |
| Billing | **Prepay** by default since 2026-03-23: credits bought in advance, expire in 12 months, **all keys on the billing account stop with 402 at $0**; auto-reload optional; docs contradict themselves on whether Prepay→Postpay is allowed | standard monthly Cloud Billing; no prepaid mode found |
| Auth | API key (new keys are service-account-bound "auth keys"; unrestricted keys rejected) | IAM / ADC on the Cloud Run service account — nothing to leak or rotate |
| SLA | none published | 99.5 % monthly for `generateContent` |
| Quotas | tier caps at the **billing-account** level: Tier 1 $250/mo, Tier 2 $2,000, Tier 3 $20k+; $10–200 per rolling 10 min | spend-based org tiers (Flash: 2M TPM at $10–250/mo spend, 4M at $250–2k …), opportunistic above tier; Provisioned Throughput available (not worth it here) |
| Cheaper tiers | Batch −50 % | Batch −50 % (1K only), **Flex −50 % synchronous** (not NB 2.1) |
| Data use | paid tier: not used to improve products | not used to train without permission; zero-data-retention achievable; CMEK / `us`/`eu` residency |
| Model availability | NB 2.1 same day on both (2026-10-06) | same; NB 2.1 is **global endpoint only** |
| Budgets | Cloud Billing spend-cap budgets now cover both services (`generativelanguage` and `aiplatform`); budgets are alerts with hours of delay, caps are "not instant" | same |
| Under-18 terms | prohibited (Gemini API terms) | prohibited (Cloud terms §20(d)) |
| Migration | — | `new GoogleGenAI({ vertexai: true, project, location: 'global' })`, grant the service account the platform user role, same `generateContent` shape; realistically bundled with the SDK upgrade (0.7.0 → 3.x, FC-042): ~1 day |

Google's own guidance: "Most developers should use the Gemini Developer API unless there is a need
for specific enterprise controls." For a paid consumer product the enterprise controls are the
point: postpaid billing with budgets instead of a credit cliff, IAM instead of a key, an SLA.

### Other providers (image step only; all *(unverified)* except where official)

| Provider | ~1K price | Multi-reference characters | Text in image | Minors policy |
|---|---|---|---|---|
| Google NB 2.1 (official) | $0.0336; batch $0.0168 | up to 14 (10 object + 4 character) | ~91 % (third-party, NB 2) | **prohibited** |
| OpenAI gpt-image-2 (official table) | low $0.006 / medium $0.053 / high $0.211; batch −50 % | multiple inputs; docs warn about recurring-character consistency | strongest in third-party tests | **"Under 18 API guidance"** — conditions, not a ban |
| OpenAI gpt-image-1.5 / 1-mini | $0.034 / $0.011 medium | as above | 1.5 strong | as above |
| BFL FLUX 3 Image / Klein (official pricing page) | $0.048 / **$0.009** | up to 10 (third-party) | marketed, no figure | not checked |
| Ideogram 4.x | ~$0.03–0.10 (aggregator) | character reference exists | historically a leader | not checked |
| Recraft V4 / Stability | $0.04 / $0.025–0.08 | style refs mainly | weaker | not checked |
| ByteDance Seedream 5 | ~$0.045 (reseller) | up to 10 | ~89 % | not checked; data-jurisdiction concern |

### Recommendation

1. **Phase 0 — legal gate (blocking for broad release, not for the beta):** counsel's view on
   whether the product is "directed towards or likely to be accessed by" under-18s under Google's
   terms, and a written answer from Google's account team. In parallel, read OpenAI's under-18
   guidance and one or two other providers' terms for the same question.
2. **If Google is viable:** move to **Vertex AI** together with the SDK upgrade (FC-042), on a
   **dedicated billing account** (section 5). Same prices, postpaid, SLA, IAM, Flex, spend caps.
3. **If Google is not viable:** OpenAI gpt-image-2 is the only credible alternative for text baked
   into images (1.6× the price; batch brings it to ≈ $0.027), and it has a minors framework. The
   text model would move too.
4. **Either way:** put the image step behind a small provider interface
   (`generateImage(prompt, references[], options) → bytes + usage`), because the bake-offs in
   section 3 (L3, L11) and the provider decision all need it. Keep the Developer API as a
   fallback provider behind the same interface.

## 5. Billing isolation (item 1) — concrete steps

1. Create billing account "Magic Storybook" (or re-use a clean one) and link `ai-storybook-app-2025`
   to it (`gcloud billing projects link ai-storybook-app-2025 --billing-account=<NEW>`). Unlinking
   from the shared account also removes the storybook from the options-wheel account's Gemini tier
   caps and prepaid pool.
2. On the new account: if staying on the Developer API, buy credits and turn on **auto-reload with
   a monthly cap**; if on Vertex, nothing to prepay. Note the new account starts at **Tier 1**
   ($250/month Gemini cap; Tier 2 after $100 paid + 3 days).
3. **Budgets:** one alerts-only budget at expected spend, one **spend-cap budget** on the Gemini
   service as a hard stop, and a separate low "panic" budget wired via Pub/Sub to a function that
   can disable billing (Google warns this can irretrievably delete resources — last resort only).
4. **BigQuery billing export** into a dataset in the storybook project; labels (`app=storybook`,
   `env=prod`) on Cloud Run, buckets and the Firestore database for attribution.
5. Project hygiene from the Firebase launch checklist: a project lien, a `prod` tag, a second
   Owner, dev/test separated from prod.
6. Fix the local tooling trap found today: Application Default Credentials on the dev machine
   bill to the options-wheel project (`gen-lang-client-0607444019`), so local Cloud Vision calls
   fail unless `GOOGLE_CLOUD_QUOTA_PROJECT=ai-storybook-app-2025` is set.
7. Decide what, if anything, in the options-wheel project still uses Gemini keys on the shared
   pool, so that app's credits and alerts are sized for it alone.

## 6. GCP production practices for a consumer app (item 3)

Ordered by what a launch review would ask first.

**Before broad release**
- **Spend controls at the app level:** per-user generation quota (Firestore counter in the same
  transaction as the job claim), subscription-tier entitlements enforced server-side, a per-story
  `costUsd` written from usage telemetry (FC-045 added the fields), per-user monthly cost cap.
  Billing-level caps are hours late and all-or-nothing.
- **Abuse protection:** Firebase App Check via `@react-native-firebase/app-check` (App Attest /
  DeviceCheck; needs the dev client, which the app already uses) and `verifyToken()` on
  `/api/stories/generate`; the backend currently accepts any valid Firebase ID token. Cloud Armor
  needs an external load balancer (~$18/month + ~$5/policy) — defer; per-UID quotas cover this
  scale.
- **Image serving:** today pages are **public GCS URLs** with the child's first name baked into
  the pixels, reachable forever and after account deletion (plus 7-day soft delete). Switch to a
  private bucket with short-lived signed URLs (or Firebase Storage rules), stable client cache
  keys, non-enumerable object names. CDN not needed yet.
- **Account deletion (Apple 5.1.1(v)):** one server-side `DELETE /api/account` that removes
  Firestore docs, the GCS prefix, revokes Sign in with Apple tokens, then deletes the Firebase Auth
  user; handle Apple's server-to-server account-delete notification with the same pipeline; state
  backup/PITR retention in the privacy policy.
- **Background work:** the fire-and-forget 202 worker depends on CPU-always-allocated and heartbeat
  locks (FC-017/030). The standard pattern is Cloud Tasks → a private Cloud Run endpoint with
  OIDC, idempotent handlers (deterministic page-doc IDs already exist), Cloud Run Jobs for long
  work. Not urgent while it works, but it is the fragile piece.
- **One SLO** (story success rate, p95 end-to-end) with uptime checks and alerting on top of the
  FC-032 policies; Error Reporting.
- **Secrets:** Vertex removes the Gemini key; otherwise schedule rotation (Secret Manager only
  notifies).
- **Observability of AI spend:** log-based metrics on the FC-045 `call` telemetry (tokens, model,
  finish reason); reconcile monthly against the billing export.

**Later**
- min-instances = 1 once latency complaints appear; multi-region only under SLO pressure;
  committed-use discounts only with steady spend; Cloud CDN when egress is visible on the bill.

## 7. App Store and children's-privacy requirements (item 3, non-GCP)

- **Positioning:** marketing to parents (Education or Books; no "for kids" in metadata) avoids
  the Kids Category, whose rules would block the paywall and sign-in flows unless parental-gated
  and arguably block sending a child's name to a third-party AI at all. Comparable: Oscar Stories
  is Education, 4+, "Made for Ages 6–8."
- **Apple 5.1.2(i) (Nov 2025):** explicit permission before sharing personal data with third-party
  AI → a consent screen naming the provider before the first generation, not a privacy-policy line.
- **Apple 1.2 now covers "AI content creation apps":** content filter (exists: FC-037/041), a
  report-this-page mechanism with timely response, block abusive users, published contact info.
- **Subscriptions (3.1.1/3.1.2):** in-app purchase only; StoreKit 2 + App Store Server API +
  Server Notifications V2 with the backend as entitlement source of truth; paywall must show
  renewal price prominently, restore purchases, Terms and Privacy links; Family Sharing is
  irreversible; enroll in the Small Business Program (15 %).
- **Privacy labels and manifest:** declare the child's first name as User Content linked to the
  user; `PrivacyInfo.xcprivacy` for required-reason APIs and listed SDKs (FirebaseAuth, Firestore,
  …) — Expo supports `ios.privacyManifests`.
- **Sign in with Apple:** already offered (required because Google sign-in exists). Register the
  email sender domain with Apple's private relay or password-reset mail to relay addresses
  bounces; persist the name from the first sign-in; never key accounts on email.
- **COPPA (amended rule fully enforceable since 2026-04-22):** a first name typed by a parent is
  generally outside "collected from a child," but a cartoon storybook reader can be found
  "directed to children," which would bring persistent identifiers (Firebase installation IDs,
  analytics, IPs) in scope. Needed regardless: a written data-retention policy, a written security
  program, written assurances from processors (Google), no third-party analytics or ads in the
  reading flow, and **counsel's determination** on "directed to children" plus state laws
  (California AADC, Texas SB2420 — not researched).

## 8. Open questions for the owner

1. Target price per story / per month, and whether a slower "batch" tier is acceptable product-wise.
2. Appetite to revisit baked-in text (L11) — the only path well below $0.30.
3. Who handles the Google terms question (counsel, Google account team) and by when.
4. Does anything in the options-wheel project still use Gemini keys?

---

## Sources

Google: aistudio.google.com/docs/{billing, pricing, rate-limits, api-key, terms, changelog,
batch-api, caching, image-generation, migrate-to-cloud, tokens};
cloud.google.com/terms/service-terms (§20); cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing;
cloud.google.com/vertex-ai/generative-ai/sla; docs.cloud.google.com/gemini-enterprise-agent-platform/models/{standard-paygo,
quotas, flex-paygo, priority-paygo, provisioned-throughput, capabilities/batch-inference,
capabilities/image-generation, gemini/nano-banana-2-1}; docs.cloud.google.com/billing/docs/how-to/{budgets,
budgets-spend-caps, disable-billing-with-notifications, export-data-bigquery};
docs.cloud.google.com/run/docs/{tips/general, configuring/min-instances, triggering/using-tasks};
docs.cloud.google.com/storage/docs/soft-delete; docs.cloud.google.com/firestore/native/docs/pitr;
docs.cloud.google.com/secret-manager/docs/secret-rotation; firebase.google.com/support/guides/launch-checklist;
firebase.google.com/docs/app-check/custom-resource-backend; rnfirebase.io/app-check/usage.
Apple: developer.apple.com/app-store/review/guidelines/ (updated 2026-10-16);
developer.apple.com/support/offering-account-deletion-in-your-app/; developer.apple.com/app-store/{subscriptions,
small-business-program, app-privacy-details}/; developer.apple.com/support/third-party-SDK-requirements/;
developer.apple.com/help/account/capabilities/configure-private-email-relay-service/.
FTC / law: law.cornell.edu/cfr/text/16/312.2; ftc.gov COPPA FAQ; ftc.gov 2025-01 press release;
dwt.com 2025-05 COPPA amendments summary.
Other providers *(unverified unless official)*: developers.openai.com/api/docs/{pricing,
guides/image-generation, guides/your-data, guides/safety-checks/under-18-api-guidance}; bfl.ai/pricing;
recraft.ai/docs/api-reference/pricing; docs.stability.ai/pricing; third-party benchmark and pricing blogs.
Market: createstory.ai/pricing; childbook.ai; apps.apple.com/app/id1663618939.
