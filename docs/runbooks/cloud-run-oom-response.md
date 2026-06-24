# Runbook: `storybook-api` error rate alert / suspected OOM

**Last verified:** 2026-06-23 (initial; not yet exercised against a real OOM since FC-025 raised memory to 2 GiB).

## Symptom

The `storybook-api error rate` Cloud Monitoring alert fires: `severity>=ERROR` log entries from the Cloud Run service are >5/5min sustained. Multiple users may also report that generations are failing.

## Diagnosis

1. **Get recent ERROR logs:**
   ```bash
   gcloud run services logs read storybook-api --region=us-central1 --limit=200 \
     | grep -E 'ERROR|FAIL|OOM|killed'
   ```
   Look for patterns: is it one user / one storyId, or distributed? Is it one specific error class, or varied?

2. **Check for OOM-killed containers** (Cloud Run's OOM-kill message is `Memory limit of XXXMi exceeded with YYYMi used` — filter on the prefix string Cloud Run actually emits, not "out of memory"):
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="storybook-api" AND textPayload:"Memory limit of"' \
     --limit=20 --format='value(timestamp,textPayload)'
   ```
   Each match represents a request that was terminated by the kernel.

3. **Check instance scaling:**
   ```bash
   gcloud monitoring dashboards list --format='value(displayName)'
   # If no dashboards yet (we don't have one until FC-034), use the Cloud Console
   # → Cloud Run → storybook-api → Metrics tab. Look at:
   #   - Container instances (last 1h)
   #   - Container memory utilization (last 1h)
   #   - Request count + Request latency
   ```

4. **Identify affected stories:**
   ```bash
   gcloud run services logs read storybook-api --region=us-central1 --limit=200 \
     | grep -E '\[story:[a-z0-9-]+\]' | grep -E 'ERROR|FAIL' \
     | sed -E 's/.*\[story:([a-z0-9-]+)\].*/\1/' | sort -u
   ```

## Common causes + Resolution

### Cause A — Genuine OOM under concurrent load
Multiple stories on the same instance peaked memory simultaneously. FC-025's concurrency math sized for 4 concurrent × ~321 MB/story on 2 GiB = ~63% utilization, but the per-story peak can be higher under retry pressure (OCR-regen + parallel char-refs).

**Resolution (short-term):** bump memory:
```bash
gcloud run services update storybook-api --region=us-central1 --memory=3072Mi
```
Test with one story; if stable, leave it. Pin in `cloudbuild.yaml` (currently `--memory=2048Mi`).

**Resolution (long-term):** reduce per-story memory (downscale char-ref images, free Buffer after upload to GCS, etc.) — file an FC for this work. Or reduce `--concurrency=4` to 2 (halves throughput per instance but halves peak memory).

### Cause B — Gemini API outage cascade
Every story is failing with `failureReason='generation_error'` or `network_error`, all happening within minutes. Not a Cloud Run problem; Gemini is down.

**Resolution:** wait it out. Check the [Google Cloud status dashboard](https://status.cloud.google.com/). Consider pausing the create-story button at the mobile level if extended (>30 min). Future hardening: backend should return a `503` immediately on `/generate` if recent Gemini failure rate is >80% (circuit breaker; file FC).

### Cause C — Recent deploy introduced a regression
The error spike started shortly after a Cloud Build deploy. Check `gcloud run revisions list`. The bad commit is in the most-recent revision.

**Resolution:** roll back per [cloud-run-rollback.md](cloud-run-rollback.md).

### Cause D — Firestore unavailability
Error logs show "DEADLINE_EXCEEDED" or "UNAVAILABLE" against Firestore operations. Stories may be stuck-generating because heartbeats can't write.

**Resolution:** wait for Firestore to recover; the sweep + Phase 2 resume will pick up orphaned work afterward.

### Cause E — Bearer-token / auth drift
Logs show `401` on `/api/admin/sweep-orphans` repeatedly. Sweep is failing but not user-visible. Run [sweep-job-failing.md](sweep-job-failing.md).

## Validation

- Error log rate drops back to baseline (<1/5min).
- The monitoring alert auto-resolves within ~5 min.
- A test story generated end-to-end succeeds.

## Audit trail

Document every incident with: when, how detected, root cause, resolution, prevention follow-up FC if any. Add a one-line summary here:

- _(blank — no real OOM incidents since 2 GiB raise on 2026-06-22)_
