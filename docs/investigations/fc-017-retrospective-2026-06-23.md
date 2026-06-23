# FC-017 retrospective adversarial review — 2026-06-23

**Why this exists:** FC-017 (the 4-phase async-job + resumability + orphan-sweep rollout that closed the 2026-05-12 instance-death incident) shipped over 3 PRs (#23, #26, #29). Each PR got per-PR adversarial review (PR #29 got two rounds + a confirmation pass). After the full system was live, the user asked for a **system-level** retro review to catch cross-phase interactions that per-PR reviews structurally can't see.

This note captures the raw findings, my verification of each against the deployed code, and the consolidated follow-up FC list. Three follow-up FCs (FC-029, FC-030, FC-031) were filed and shipped from this investigation; the verdicts and reasoning live here so the FCs themselves stay tight.

## Method

Four independent adversarial reviewers, each spawned as a `general-purpose` agent with a distinct domain persona, each given the FC-017 + FC-025 plans, full repo access, deployed-state inspection via `gcloud`, and the CLAUDE.md adversarial-review template:

1. **Distributed-systems / Firestore SRE** — lock contention, transaction retry, `serverTimestamp()` semantics, index coverage, privacy boundary.
2. **Mobile state-machine auditor** — every `status × failureReason × screen` combination; `onSnapshot` cleanup; useRef-guarded navigation; React Query ↔ Firestore subscription coherence; app-kill+reopen; offline; auth-token freshness.
3. **Cloud-ops / observability engineer** — discoverability of sweep failures, alerting, runbook readiness, secret rotation, backups, CI gates, quota.
4. **Incident-closure auditor** — walks the 2026-05-12 incident step-by-step under the new architecture; declares CLOSED / PARTIALLY-CLOSED / NOT-CLOSED for the originating failure + 12 near-neighbor failure modes.

## Verdicts

| Reviewer | Verdict | BLOCKERs | HIGHs | MEDs | LOWs |
|---|---|---|---|---|---|
| R1: Distributed-systems | REQUEST_CHANGES | 3 | 3 | 3 | 2 |
| R2: Mobile state-machine | REQUEST_CHANGES | 0 | 4 | 7 | 4 |
| R3: Cloud-ops | REQUEST_CHANGES | 4 | 7 | 6 | 3 |
| R4: Incident-closure | PARTIALLY-CLOSED | — | — | — | — |

No reviewer recommended rollback. R4: the *data-layer* aspects of the 2026-05-12 failure (data loss, silent success) are genuinely closed; the *user-visible-symptom* aspects (waiting forever, no recovery) can still recur via different vectors.

## Convergent findings (multiple reviewers, independently)

These are the most credible — surfaced from different angles by reviewers who didn't see each other's output:

1. **Sweep ↔ Resume race → split-brain → duplicate pages** (R1 BLOCKER-1, R2 MEDIUM-7). Treated as `corruption-class-1` below.
2. **Sweep is invisible if broken** (R3 B-3, R4 R-3). Treated as part of FC-031 ops-floor.
3. **Library doesn't live-update during generation** (R2 HIGH-1, R4 R-6). Direct contradiction of FC-017's user promise. Treated as FC-030.
4. **No retry budget on Resume** (R2 state-machine gap, R4 R-2/R-4). Treated as FC-030.
5. **Sweep auth token leaked via `cloudscheduler.jobs.get`** (R1 HIGH-1, R3 H-3/L-3). Already rotated mid-session; OIDC migration tracked in FC-031.

## Verification of each BLOCKER against the deployed code

### R1 BLOCKER-1 — Sweep ↔ stale-lock-takeover split-brain → duplicate pages in subcollection

**Reviewer's mechanism (paraphrased):** sweep's query returns docs whose `workerHeartbeatAt < cutoff`. Between the `.get()` and the batch-update, a worker takeover lands a fresh heartbeat. Sweep's batch-update clobbers the doc to `status:'failed:orphaned'` + clears `workerId` + clears `workerHeartbeatAt`. User taps Resume → claimLock at [worker.ts:278](backend/src/services/worker.ts#L278) skips the lock-held branch because `workerId === undefined` → second worker claims. Both workers run to success-path. Success-path batch writes pages with **auto-id'd doc references** at [worker.ts:377](backend/src/services/worker.ts#L377) (`storyRef.collection('pages').doc()` — auto-id). Two batches → 2N page docs in subcollection. Mobile reader (orders by `pageNumber`) renders every page twice.

**Verification:** confirmed. The reviewer's exposition mentioned "Firestore queries are eventually consistent on writes between query-prep and query-execute" — that's actually incorrect terminology for within-region Firestore (queries are strongly consistent at the index level for committed writes). But the underlying race is real: the window is **between sweep's `.get()` returning and sweep's `.batch().commit()` landing** (~100-500ms), during which a worker takeover can complete its transaction and land a fresh heartbeat. The sweep then clobbers it without re-reading.

A second, related path: the SIGTERM handler at [worker.ts:488-513](backend/src/services/worker.ts#L488-L513) sets `status:'failed:sigterm'` during the very moment the success-path `batch.commit` is in flight. Pages land atomically (batch is atomic) but `status` ends up `'failed:sigterm'`. User Resumes → second worker → loadJobState sees `storyText`/`pageUrls`/`progress` were deleted by the success-batch → regenerates everything → second batch lands → 2N page docs.

**Real corruption class.** Severity: BLOCKER (under load — needs concurrent Resume + Cloud Run scale-down, but both are normal production conditions).

### R1 BLOCKER-2 — SIGTERM during success-path `batch.commit` clobbers `status:'complete'`

**Verification:** confirmed (folded into the above). The SIGTERM handler at [worker.ts:488-513](backend/src/services/worker.ts#L488-L513) iterates `inFlightWorkers` (storyId is still present until the outer finally at [worker.ts:321](backend/src/services/worker.ts#L321) runs, which only fires after `runStoryWorkerImpl` returns — which is gated on `await batch.commit()` resolving). Handler fires a separate non-awaited `update({status:'failed:sigterm', ...})`. Race: success-batch atomic write (status='complete' + pages + clears) vs. SIGTERM single-field update. Last-write-wins on `status`. Pages always land.

Same `corruption-class-1`. Same fix: deterministic page IDs.

### R1 BLOCKER-3 — `fireWorkerInBackground` catch can clobber a healthy in-flight worker

**Reviewer's mechanism:** Worker A's catch at [worker.ts:430-456](backend/src/services/worker.ts#L430-L456) writes `status:'failed'` atomically. User taps Resume within ~50ms → Worker B's claimLock proceeds (workerId is undefined; status='failed' not 'complete') → Worker B starts and writes `status:'generating'`, fresh heartbeat. Concurrently, Worker A's `runStoryWorker` promise rejects → bubbles to `fireWorkerInBackground` catch at [stories.ts:78-109](backend/src/routes/stories.ts#L78-L109). Not LockHeldError → re-read guard at line 99 sees `status:'generating'` → falls through (only short-circuits on `complete`/`failed`) → writes `status:'failed:unknown'` clobbering Worker B's healthy state.

**Verification:** confirmed but downgraded. The clobbering write at [stories.ts:102-105](backend/src/routes/stories.ts#L102-L105) only writes `status` + `failureReason` — it does NOT touch `workerId` or `workerHeartbeatAt`. So after the clobber, `workerId=B` is still set. Worker B's heartbeat keeps refreshing. If the user Resumes again, claimLock sees workerId=B with fresh heartbeat → throws `LockHeldError` → second Resume is correctly rejected. Worker B eventually completes its success-path batch and overwrites `status` back to `'complete'`. Net effect: **UX flicker (generating → failed → complete), not data corruption.** Severity downgraded from BLOCKER → HIGH. Fix bundled with FC-029.

### R3 B-1 — No Firestore backups, no point-in-time recovery

**Verification:** confirmed via `gcloud firestore databases describe '(default)'` → `pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_DISABLED`, `versionRetentionPeriod: 3600s` (the free-tier 1-hr window). `gcloud firestore backups list` → empty. `gcloud firestore backups schedules list` → empty.

**Severity confirmed:** BLOCKER. The FC-025 `FieldValue.serverTimestamp()` nested-map footgun was a near-miss (silently wrote nulls); the next bug of that class corrupts every story doc with no recovery path.

### R3 B-2 — `maxScale=20` not pinned in `cloudbuild.yaml`

**Verification:** confirmed by reading `cloudbuild.yaml` — pinned `--memory`, `--concurrency`, `--timeout`, `--no-cpu-throttling`; `--max-instances` is absent. Current `maxScale=20` is a manual annotation on the service. Cloud Run preserves annotations across deploys *that don't override them*, so a future deploy adding `--max-instances=N` (or a forced full-spec apply) regresses to default `1000`.

**Severity confirmed:** BLOCKER (cost class — at default `1000` × `concurrency=4` × Gemini bill, a burst is unboundedly expensive). Fix: pin in cloudbuild.yaml.

### R3 B-3 — Zero alerting / monitoring

**Verification:** confirmed via `gcloud monitoring policies list` → 0; `gcloud logging metrics list` → 0; `gcloud beta monitoring channels list` → 0. Plan's Risks §1 explicitly called out "add a Cloud Run log-based alert on uncaught exceptions" — never done.

**Severity confirmed:** BLOCKER (operational class). MTTD for the exact 2026-05-12 incident class is days-to-weeks (customer complaint volume), the same MTTD the original incident had.

### R3 B-4 — Cloud Scheduler doesn't actually retry on failure

**Verification:** confirmed via `gcloud scheduler jobs describe sweep-orphans` → `retryConfig.maxRetryDuration=0s`, no `retryCount`. The release notes' claim that "scheduler retries cover the `FAILED_PRECONDITION: index is currently building` error" was wrong — the *next 10-min cron tick* covered it, not retry. If the index had taken longer to build, every tick would have failed silently.

**Severity:** HIGH (combined with B-3's lack of alerting it becomes BLOCKER-class; alone it's recoverable on the next tick).

## R4 incident-closure summary

R4 walked the 12 near-neighbor failure modes:

| # | Failure mode | Status |
|---|---|---|
| 1 | Instance dies mid-char-ref (original 2026-05-12) | PARTIALLY-CLOSED — data layer fixed; 5-15 min stuck-spinning UX window remains |
| 2 | Instance dies mid-illustration-page | PARTIALLY-CLOSED (same as #1) |
| 3 | Instance dies between heartbeat.stop() and batch.commit() | CLOSED (sweep recovers) |
| 4 | Gemini non-retryable error 5h into retry chain | CLOSED (MAX_RETRIES=3; ~14s tail) |
| 5 | SIGTERM during scale-down | CLOSED (handler best-effort marks failed:sigterm) |
| 6 | Split-brain (two instances same storyId) | CLOSED (transactional claimLock) |
| 7 | App-kill + reopen 2min later | CLOSED |
| 8 | App-kill + reopen 30min later (worker finished) | CLOSED (silent-success bug closed) |
| 9 | User never opens app again | STILL-OPEN (no push notification; explicitly out-of-scope per plan) |
| 10 | Story fails 5 times in a row | STILL-OPEN (no retry budget; `attempt` counter exists but nothing reads it; user can burn ~$5/Resume cycle) |
| 11 | Sweep broken (Scheduler stopped firing) | STILL-OPEN (no alerting; MTTD = days) |
| 12 | User submits 10 stories in 60s | PARTIALLY-CLOSED (works; no per-user rate limit; concurrent-instance memory pressure unproven) |

**Conclusion:** the original 2026-05-12 failure mode is closed at the data layer. The user-visible outcome ("I waited and got nothing useful") can still recur via #1 (stuck-spinning), #10 (cost loop), #11 (silent-sweep-death) — addressed by FC-030 (retry budget + library live-update + watchdog) and FC-031 (alerting).

## Token-rotation incident

Reviewer R3 demonstrated the Cloud Scheduler bearer-token leak by printing the production `SWEEP_AUTH_TOKEN` value in its findings — landing the live secret in the conversation transcript. The structural exposure already existed (Project Viewer role grants `cloudscheduler.jobs.get` which returns the header value in cleartext), but the audit made it concrete.

**Rotation completed mid-session (2026-06-23):**
1. `openssl rand -base64 48` → new token
2. `gcloud secrets versions add sweep-auth-token --data-file=…` → version 2
3. `gcloud scheduler jobs update http sweep-orphans --update-headers="Authorization=Bearer $NEW,…"` → Scheduler now uses v2
4. `gcloud run services update storybook-api --update-secrets=SWEEP_AUTH_TOKEN=sweep-auth-token:latest` → Cloud Run revision `00126-77h` resolves v2
5. Smoke-tested new token → 200
6. `gcloud secrets versions disable 1 --secret=sweep-auth-token` → leaked token now inactive
7. Local copy of token scrubbed.

The leak class (any future Viewer can read the live token) is closed by the OIDC migration in FC-031.

## Consolidated follow-up FC list

Three FCs filed from this investigation. All ship with plan files in `docs/plans/`.

| FC | Title | Severity | Source findings |
|---|---|---|---|
| **FC-029** | Corruption-class hotfix: deterministic page IDs + sweep transactional re-read + SIGTERM-aware finalize + transactional bg-catch | BLOCKER | R1 BLOCKER-1+2+3, R2 MEDIUM-7 |
| **FC-030** | Mobile hardening: library live-update + `navigatedRef` stuck-state + retry budget + `permission_denied` recovery + watchdog | HIGH (functional gap vs. plan promise) | R2 HIGH-1+2+3+4, R4 R-1+R-2+R-6 |
| **FC-031** | Ops floor baseline: Firestore PITR + daily backups + pin `--max-instances` + alerting + CI test gate + OIDC sweep + runbooks | BLOCKER (data class) | R3 B-1+B-2+B-3+B-4+H-1+H-2+H-3+H-5+H-6, R4 R-3 |

Deferred to future sessions (filed but lower-priority):
- Firestore emulator + integration test suite for the worker concurrency code (R1 MEDIUM-3).
- Log-based metrics + Cloud Monitoring dashboard for the Phase 1 instrumentation (R3 M-2).
- `safety_blocked` UX → "Create new story" instead of misleading Resume (R2 state-machine gap).
- Doc-size telemetry + storyText → subdoc migration (R1 MEDIUM-2 / FC-025 M-6 deferred).
- Per-user concurrency rate-limit (R4 #12).
- Push notifications when a story completes (R4 #9 / FC-017 plan §155 explicitly deferred).

## Process lesson

The **per-PR adversarial review pattern** (even at the two-round + confirmation tier we used for PR #29) is **structurally blind to system-level interactions** — sweep vs. worker race, library vs. /generating cache coherence, mobile vs. backend state-machine completeness. The retro review caught defects that all three per-PR reviews missed.

For future FCs of this scale (multi-phase, distributed, multi-process), **add a system-level retro review as a final gate before declaring the FC Done**. Cheap insurance compared to discovering a production data-corruption bug after-the-fact. Update CLAUDE.md to codify this for the next plan-driven FC of similar scope.
