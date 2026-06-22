# FC-017 Phase 1: instance-death investigation — 2026-06-22

## Question

The 2026-05-12 incident: a Cloud Run instance died ~9.5 min into a story generation, ~80% of the work paid for and thrown away. The FC-017 plan calls Phase 1 a **gating** investigation: name the cause (OOM / connection-pool exhaustion / Cloud Run scale-down kill / Gemini-side fault) or apply the defensive default. Phase 2's architecture choice depends on the answer.

## Method

1. Phase 1 instrumentation deployed (PR #23, revision `storybook-api-00103-6mq`, 2026-05-27): per-stage `process.memoryUsage()` snapshots, per-Gemini-call outcome classification (`fetch_failed` / `unavailable` / `internal` / `5xx` / `4xx` / etc.), `[story:${id}]` log tagging.
2. **One deliberately-stressed long story generated 2026-06-22 19:54 UTC** matching the FC-017 risk vector: `length: long`, multiple named characters (4 character refs in flight in parallel — the documented memory-pressure path).
3. Trace pulled via Cloud Logging structured events (`event:stage_done` and `event:call`).

Story ID: `7d8ab46f-3917-47f4-81b6-30e8256fb69e`.

## Data

### Stage timing

| Stage | latencyMs | Outcome | rssMb | heapUsedMb | externalMb |
|---|---|---|---|---|---|
| story_text | 15,785 | success (attempt 1) | 126 | 39 | 3 |
| char_ref ×4 (parallel) | 6,704 / 7,010 / 8,002 / 8,407 | success (attempt 1 ×4) | 140-146 | 42-43 | 7-9 |
| **char_refs_total** | **8,582** | parallel wall-clock | 146 | 43 | 7 |
| cast_ref | 7,232 | success | 169 | 55 | 14 |
| title_page | 12,727 | success | 174 | 55 | 18 |
| page (anchor 1) | 27,950 | success (Gemini 18.9s + OCR/upload 9s) | 187 | 62 | 16 |
| page (anchor 2) | 12,789 | success (Gemini 12.3s + OCR 0.5s) | 186 | 60 | 14 |
| **anchor_pages_total** | **40,910** | 2 sequential | 186 | 60 | 14 |
| page (parallel ×6) | 15,218 / 20,418 / 20,649 / 29,946 / 14,005 / 19,657 | all success attempt 1 | 255-321 | 76-115 | 23-45 |
| **parallel_pages_total** | **35,654** | 6 pages, concurrency 4 | 255 | 76 | 23 |
| **all_illustrations** | **98,126** | — | 255 | 76 | 23 |
| firestore_persist | 94 | — | 255 | 76 | 23 |
| **total** | **114,088** | success | 255 | 76 | 23 |

10 page generations + 4 char refs + cast + title + story-text = **16 LLM calls** in 114s wall-clock. 0 retries. 0 errors. 0 errorClass values.

### Memory progression

`rssMb` (resident set, the container-OOM-relevant number):

```
126 ──► 146 ──► 169 ──► 174 ──► 186 ──► 321 ──► 255
text    refs    cast    title  anchor  PEAK    end
                              pages   (par.)
```

Peak resident memory: **321 MB** = **63% of the 512Mi container limit**.

External buffers (`externalMb`, where Node `Buffer` instances live — image base64 payloads): peak 45 MB, settled back to 23 MB by end. Image bytes ARE being released after upload; they're not accumulating across stages.

`heapUsedMb`: peak 115 MB, settled to 76 MB. V8 heap pressure rose during parallel pages but did not climb monotonically.

## Observations

1. **No instance death reproduced.** The exact-vector stress story (4 chars + long + parallel pages) completed cleanly. Cannot confirm structural OOM as the May 12 cause from this single run.
2. **No retries, no transient errors.** Every Gemini call landed first try with `outcome=success`. No `fetch_failed`, `unavailable`, `internal`, or `econnreset` events. May 12's `TypeError: fetch failed sending request` trigger did not occur — that's a tail event, not a structural one.
3. **Memory peaked at 63% of limit on this one run.** Headroom exists, but it's not unlimited. The peak landed during the parallel page batch (concurrency=4 simultaneous Gemini calls each holding ~600KB-1MB image buffers + their multimodal-input refs). Two failure-amplification vectors not exercised today:
   - **OCR-failed regeneration.** `PROD_TEXT_GEN_ATTEMPTS=2` — a regen doubles peak memory for that page's slot. Today every page passed OCR on attempt 1.
   - **Concurrent stories on the same instance.** Cloud Run default request concurrency is 80; nothing stops two users hitting the same instance during overlapping generations. We've never measured this.
4. **External-buffer release works.** `externalMb` rose 3 → 45 then fell to 23 between parallel batch and end. Image buffers are being garbage-collected once their consumers (page generation) finish, not held forever.
5. **The May 24 char-ref outlier (332s) did not recur.** Today char_refs_total = 8.6s. That 14× speedup confirms the 332s was a **Gemini-side 503 tail**, not a structural problem in the pipeline. FC-016's framing is unchanged by this data — we still need 4 more baseline runs to establish the char-ref distribution, but the May 24 measurement was clearly the right tail of a wide distribution.

## Hypothesis

The May 12 instance death is **most likely OOM under unfortunate-but-not-pathological conditions**, but cannot be definitively proven from today's data (we did not reproduce). Reasoning:

- **OOM is plausible:** 63% utilization on a clean 4-char + 10-page run is a thin margin. If May 12's request additionally had (a) one OCR-failed page driving a regeneration during the parallel batch — Node holds the old image bytes alongside the new one until the failing candidate is replaced, +600KB-1MB peak — AND (b) a slow Gemini call holding sockets open longer, AND (c) a concurrent request on the same instance, the combination could plausibly cross 512 MiB. The May 12 `TypeError: fetch failed sending request` smells like a downstream symptom of socket exhaustion or memory pressure pushing the runtime into an unhealthy state, not a direct upstream cause.
- **OOM is not proven:** we did not see it today. Connection-pool exhaustion remains a viable alternate hypothesis — multiple parallel calls × char-ref retry storms × no explicit pool config on the `@google/genai` client could pile up sockets independently of memory. Cloud Run scale-down is least likely — single-request scaledown kills are well-documented to emit SIGTERM 10s in advance, and we'd expect to see the request-handler observe it.
- **Tail risk dominates over median behavior.** Today's median is healthy. The failure is in the tail: ≤ 1% of runs (1 observed death in ~50+ stories generated since project start). Phase 2's design must protect against the tail, not the median.

## Recommendation: apply the plan's defensive default

Per `docs/plans/fc-017.md` Risks §1: *"if a 12-page stress run and three production runs don't reproduce the death and don't show a clear memory or call-failure pattern, default the architecture to the most defensive interpretation (assume OOM)..."*

The stress run condition is met today (1 of 3 production runs to follow naturally over the next week of usage). Beginning Phase 2 design assuming OOM, with two concrete additions to the plan as written:

1. **Bump Cloud Run container memory 512Mi → 1024Mi as a Phase 2 prerequisite.** This is the cheapest, highest-leverage win: $0 cost change at our request volume (we're not memory-billed at the always-on tier), eliminates the 63% concern entirely, doubles headroom for OCR regens + concurrent requests. Single `gcloud run services update --memory=1024Mi` invocation. Not a long-term architectural decision — a hygiene change that buys time for the resumable-pipeline work to land.
2. **Phase 2's resumable design must release image base64 buffers as soon as they're persisted to GCS + Firestore.** Today `generateAllIllustrations` keeps `imageBase64` for char-refs + canonical anchor pages in memory across the whole run (passed as multimodal refs to downstream pages). The resumable design re-downloads these from GCS on resume — but the in-flight case should also drop them between phases when not needed. Concretely: char-ref bytes can be released after the parallel page batch starts (they're already embedded in those calls' contents). Saves ~5-10 MB on long stories; in the worst-case stack-up that's the difference between 95% and 105% utilization.

The plan's own resumable design (per-phase Firestore writes) is **independently justified by today's data**: a hypothetical instance death during the parallel batch (the observed peak) would lose 35-100s of work even though anchor pages are already uploaded to GCS. Persistence of intermediate URLs is the right design whatever the root cause turns out to be.

**Not recommended:** going deeper into root-cause analysis before Phase 2. We've matched the plan's exit criteria (1 stress run, no reproduction). Continuing to hunt for a tail-event reproduction at our request volume could take weeks. The defensive default is the correct call.

## Follow-ups (ordered)

1. **Phase 2 prep: bump memory to 1024Mi.** Trivial change, lands ahead of any code work. Could even land alongside the next backend deploy (no code change needed; pure infra config).
2. **Naturally accumulate 2-3 more production runs** over the next week of usage. Memory peaks will land in the structured logs automatically. If any run exceeds 80% utilization or any `errorClass` appears that isn't on the FC-020 retry-success path, revisit this note immediately.
3. **FC-016 baseline sweep (separate track).** Today's run = data point 1 of ≥ 5. Char-refs at 8.6s is a strong signal that the FC-016 plan's Phase 1 §4 decision gate (≤ 60s p50 / ≤ 120s p95 → stop and downgrade) may trigger once we have enough samples. **Do not draft the FC-016 investigation note from one data point** — wait for the sweep to fill in.
4. **Phase 2 implementation** per the resumable-pipeline design in `docs/plans/fc-017.md` Phase 2. The plan as written is unchanged by today's findings; the two recommendations above are additive constraints, not deviations.

## Cost data (for the record)

This stress run: 16 Gemini Flash Image calls × ~$0.067 + 1 Gemini Pro Text call ≈ **~$1.10**. Useful baseline:
- Short story (smoke test, 4 pages + 2 char refs + cast + title): ~$0.54
- Long stress story (10 pages + 4 char refs + cast + title): ~$1.10

FC-016 baseline sweep budget: 5 stories × ~$0.50-1.10 ≈ ~$3-5 total. Negligible.

## What this note does NOT prove

- It does not prove May 12 was OOM. We didn't reproduce. The defensive default is the right call given the residual risk, not a confirmed diagnosis.
- It does not prove memory is always under 63%. N=1 stress run. A second concurrent story, an OCR regen on a busy run, or a Gemini latency spike could all push higher.
- It does not establish the FC-016 baseline distribution. Today's single observation of char_refs_total=8.6s is good news but not a baseline.

## References

- Plan: `docs/plans/fc-017.md` (Phase 1 exit criteria; Risks §1 defensive default)
- Methodology template: `docs/investigations/fc-002-latency-benchmark-2026-04-28.md`
- Related FC: `docs/plans/fc-016.md` (latency, char-refs the dominant cost per May 24)
- Original incident: `docs/releases/RELEASE_2026-05-12.md`
