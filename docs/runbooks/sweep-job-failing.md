# Runbook: sweep-orphans job failing

**Last verified:** 2026-06-23 (initial commit; not yet exercised against a real failure)

## Symptom

The `FC-017 sweep-orphans job ERROR` Cloud Monitoring alert email fires. The body says the Cloud Scheduler job `sweep-orphans` logged a severity≥ERROR entry in the last 10 minutes.

Alternative symptom: a customer reports a story stuck in `generating` for ≥15 min. Check whether the sweep has been running before drilling into the story — broken sweep is the most common cause of multiple stuck stories.

## Why this matters

The sweep is what flips orphaned stories (`status='generating'` with stale `workerHeartbeatAt`, or `status='queued'` with stale `createdAt`) to `failed:'orphaned'` so the mobile shows a Resume button. If the sweep stops firing for ≥15 min, every orphan from that window sits stuck-spinning indefinitely.

## Diagnosis

1. **Confirm the alert is real.** Check the Scheduler job's recent run history:
   ```bash
   gcloud scheduler jobs describe sweep-orphans --location=us-central1 \
     --format='value(status.code,status.message,lastAttemptTime)'
   ```
   `status.code` of `0` = OK on the most recent attempt. Non-zero = the job failed.

2. **Check the underlying Cloud Run logs for the sweep endpoint:**
   ```bash
   gcloud run services logs read storybook-api --region=us-central1 --limit=200 \
     | grep -E "sweep|admin/sweep-orphans"
   ```
   Look for the response code on the most recent attempts. Expected: `POST 200 /api/admin/sweep-orphans` every 10 min. Failures: `401` (token mismatch), `503` (env var not set), `500` (internal error — read the message), `FAILED_PRECONDITION` (index not yet built).

3. **Manually fire the sweep with the current token** to reproduce:
   ```bash
   TOKEN=$(gcloud secrets versions access latest --secret=sweep-auth-token)
   curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     https://storybook-api-983903024759.us-central1.run.app/api/admin/sweep-orphans -d '{}'
   ```
   Expected: `{"swept":N,...}` JSON response. Whatever this returns is exactly what the next cron tick will see.

## Common causes + Resolution

### Cause A — Bearer-token rotation drift
`curl` returns `401`. The Scheduler job's `Authorization` header doesn't match the current secret version. Run [secret-rotation.md](secret-rotation.md) end-to-end (you likely did steps 1-3 but not 4, or out-of-order).

### Cause B — Cloud Run revision rolled back without binding the secret
`curl` returns `503 Sweep endpoint not configured`. The new Cloud Run revision lost the `SWEEP_AUTH_TOKEN` env-var binding. Re-bind:
```bash
gcloud run services update storybook-api --region=us-central1 \
  --update-secrets=SWEEP_AUTH_TOKEN=sweep-auth-token:latest
```
Wait ~2 min for the new revision; re-test with the curl above.

### Cause C — Firestore composite index missing or building
`curl` returns `500` with `FAILED_PRECONDITION: index is currently building` or similar. Check index status:
```bash
gcloud firestore indexes composite list --filter='state!=READY' \
  --format='value(name,state)'
```
If any index is `CREATING`, wait — Firestore index builds take 1-10 min for small datasets, longer for big ones. The sweep's `retryConfig.maxRetryAttempts=3` covers transient unavailability; if the index is genuinely missing, redeploy from `firestore.indexes.json`:
```bash
npx --yes -p firebase-tools firebase deploy --only firestore:indexes \
  --project ai-storybook-app-2025 --non-interactive
```

### Cause D — IAM permission drift on the runtime service account
`curl` returns `500` with permission-denied details in the message. Check the Cloud Run runtime SA has `roles/secretmanager.secretAccessor` for the sweep token:
```bash
gcloud secrets get-iam-policy sweep-auth-token \
  --format='value(bindings.members,bindings.role)'
```
Expected: includes `serviceAccount:983903024759-compute@developer.gserviceaccount.com` with `roles/secretmanager.secretAccessor`. If missing, rebind:
```bash
gcloud secrets add-iam-policy-binding sweep-auth-token \
  --member='serviceAccount:983903024759-compute@developer.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'
```

## Validation

1. Manually fire the sweep again with the curl from Diagnosis §3. Expected: `200` + `{"swept":N,...}`.
2. Wait for the next 10-min cron tick. Confirm in `gcloud scheduler jobs describe sweep-orphans` that `lastAttemptTime` advanced and `status.code` is `0`.
3. Confirm any backlogged orphan stories were flipped:
   ```bash
   gcloud firestore export gs://… # (or via Console)
   ```
   Easier: check via the Firebase Console → Firestore → `stories` collection, filter `status='generating'`, sort by `workerHeartbeatAt`. Stories older than 5 min should now show `status='failed:orphaned'`.

## Audit trail

After resolution, **add a one-line note + date here** so future incidents know what's been seen before. Example:

- _(blank — no real failures yet as of 2026-06-23)_
