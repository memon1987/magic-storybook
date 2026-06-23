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

## Procedure (4 steps)

### Step 1 — Generate + create new secret version

```bash
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

The Scheduler job now sends the NEW token. But Cloud Run is still verifying against the OLD token (env var resolved at the prior container's start). The next tick will 401 until step 3.

### Step 3 — Roll Cloud Run to a new revision that re-resolves `latest`

```bash
gcloud run services update storybook-api --region=us-central1 \
  --update-secrets=SWEEP_AUTH_TOKEN=sweep-auth-token:latest
```

This creates a new revision whose container start-up resolves `sweep-auth-token:latest` → the new version. After this revision serves 100% of traffic (usually ~2-3 min), Cloud Run verifies against the new token. The Scheduler's new-token requests now succeed.

### Step 4 — Smoke-test, then disable the old version

```bash
NEW=$(cat /tmp/sweep-new.txt)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer $NEW" \
  -H "Content-Type: application/json" \
  https://storybook-api-983903024759.us-central1.run.app/api/admin/sweep-orphans -d '{}'
# Expected: 200
```

If `200`, disable the old version:

```bash
# Replace N with the version number that was 'latest' BEFORE step 1.
gcloud secrets versions list sweep-auth-token --format='value(name,state)'
gcloud secrets versions disable N --secret=sweep-auth-token
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
- **Reversing 2 and 3** → Scheduler keeps sending old token, but Cloud Run now expects the new one → 401 starting immediately. Recoverable by completing step 2 quickly.
- **Forgetting step 4 (disable)** → both tokens remain valid. The leaked token is still hot. Always disable.

## Future hardening

Track the OIDC migration in [docs/plans/fc-032.md](../plans/fc-032.md) — once the sweep endpoint accepts Google-issued OIDC tokens instead of a static bearer, this entire runbook becomes obsolete (Cloud Scheduler mints short-lived tokens automatically; nothing shared to rotate).
