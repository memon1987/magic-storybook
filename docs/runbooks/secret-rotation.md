# Runbook: rotating `SWEEP_AUTH_TOKEN`

**Last verified:** 2026-06-23 (exercised during the FC-017 retrospective when the token leaked into a review transcript).

## When to use

- The token has been leaked (transcript, log, screenshot, repo).
- Scheduled rotation policy (we don't have one yet — recommend every 6 months).
- A contractor with Project Viewer access was off-boarded.

## Why it's load-bearing-order-sensitive

The bearer token lives in **three** places that must update in lockstep:

1. **Secret Manager** (`sweep-auth-token` secret, current `latest` version).
2. **Cloud Run env-var binding** (`SWEEP_AUTH_TOKEN` env var on the running revision — resolves at container start, NOT live).
3. **Cloud Scheduler job header** (`sweep-orphans` job, literal `Authorization: Bearer <token>` value).

If you update only some of these or do them out of order, the next sweep tick fails with 401 and stays failing until you complete the sequence.

## Procedure (4 steps; do steps 1–3 back-to-back without pausing)

### Step 1 — Capture prior version + create new secret version + pause Scheduler

Pre-step (HIGH-2 fix — capture the version we'll disable in Step 4, so we don't have to guess later):
```bash
PRIOR_LATEST=$(gcloud secrets versions list sweep-auth-token \
  --filter='state=ENABLED' --sort-by=~createTime --limit=1 --format='value(name)')
echo "Prior latest (we'll disable this in Step 4): $PRIOR_LATEST"
```

Pause the Scheduler (HIGH-1 fix — prevents 401 alert noise during the Step 2→3 cutover window; resume in Step 4):
```bash
gcloud scheduler jobs pause sweep-orphans --location=us-central1
```

Generate + create the new version. `umask 077` so the temp file isn't world-readable:
```bash
umask 077
openssl rand -base64 48 | tr -d '\n' > /tmp/sweep-new.txt
gcloud secrets versions add sweep-auth-token --data-file=/tmp/sweep-new.txt
```

Capture the new version number from the output (`Created version [N]`).

### Step 2 — Update Cloud Scheduler job's `Authorization` header to the new token

```bash
NEW=$(cat /tmp/sweep-new.txt)
gcloud scheduler jobs update http sweep-orphans \
  --location=us-central1 \
  --update-headers="Authorization=Bearer $NEW,Content-Type=application/json"
```

The Scheduler is paused (Step 1), so no immediate effect on production. The next manual or auto tick after we resume in Step 4 will send the new token.

### Step 3 — Roll Cloud Run to a new revision that re-resolves `latest`

```bash
gcloud run services update storybook-api --region=us-central1 \
  --update-secrets=SWEEP_AUTH_TOKEN=sweep-auth-token:latest
```

This creates a new revision whose container start-up resolves `sweep-auth-token:latest` → the new version. After this revision serves 100% of traffic (usually ~2-3 min), Cloud Run verifies against the new token. The Scheduler's new-token requests now succeed.

### Step 4 — Smoke-test, disable the old version, resume Scheduler

Smoke-test the new token:
```bash
NEW=$(cat /tmp/sweep-new.txt)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer $NEW" \
  -H "Content-Type: application/json" \
  https://storybook-api-983903024759.us-central1.run.app/api/admin/sweep-orphans -d '{}'
# Expected: 200
```

If `200`, disable the old version (no guessing — we captured `PRIOR_LATEST` in Step 1):
```bash
gcloud secrets versions disable "$PRIOR_LATEST" --secret=sweep-auth-token
```

Resume the Scheduler:
```bash
gcloud scheduler jobs resume sweep-orphans --location=us-central1
```

Scrub the local copy:
```bash
rm -f /tmp/sweep-new.txt
```

## Validation

- Smoke-test in step 4 returns 200.
- `gcloud secrets versions list sweep-auth-token` shows the new version `ENABLED` and the old version `DISABLED`.
- Wait for the next 10-min cron tick. Confirm via `gcloud scheduler jobs describe sweep-orphans` that `status.code` is `0`.

## Common mistakes

- **Skipping step 3** → Scheduler's new token is rejected indefinitely. The running Cloud Run revision NEVER re-reads `latest` automatically; you must trigger a re-resolve via a new revision.
- **Reversing 2 and 3** → Scheduler keeps sending old token, but Cloud Run now expects the new one → 401 starting immediately. The pause-in-Step-1 + resume-in-Step-4 pattern makes this immaterial; if you didn't pause, complete step 2 within ~30s of step 3.
- **Forgetting step 4 (disable + resume)** → both tokens remain valid (the leaked token is still hot) AND the Scheduler stays paused (no orphan sweeps until you notice). Always finish step 4.
- **Forgetting to capture `PRIOR_LATEST` in step 1** → at 3am after smoke-test passes, you'd have to look at `gcloud secrets versions list` where TWO versions are ENABLED and guess which is the prior one. Fat-finger risk → disable the wrong (newer) version → next deploy fails.

## Future hardening

Track the OIDC migration in [docs/plans/fc-032.md](../plans/fc-032.md) — once the sweep endpoint accepts Google-issued OIDC tokens instead of a static bearer, this entire runbook becomes obsolete (Cloud Scheduler mints short-lived tokens automatically; nothing shared to rotate).
