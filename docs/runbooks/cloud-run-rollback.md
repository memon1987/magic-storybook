# Runbook: rolling back the `storybook-api` Cloud Run service to a prior revision

**Last verified:** 2026-06-23 (not yet exercised against a real bad deploy).

## When to use

- A merge-to-main deployed a bad revision and the alerting fires (`storybook-api error rate` ≥5/5min for 5min).
- A customer reports broad failures (`POST /generate` 500s, `GET /:id` empty payloads).
- You discovered a config regression post-deploy (e.g., wrong env var binding, missing secret).

## Decision tree

1. **Is the error fix-forward'able in <15 min?** (1-line change to a route file, etc.) — Yes → fix-forward with a new commit on main; the next deploy supersedes the bad one. Faster than rollback and leaves a clean history.
2. **Is the error stopping ALL traffic or just a subset?** — Stopping all → roll back immediately, fix-forward later. Just a subset → consider whether rollback would impact MORE users than the current bug.
3. **Is there in-flight work that depends on the new revision's behavior?** (e.g., the new revision shipped a Firestore schema that rolling back would break.) — Yes → fix-forward is the only safe path. Roll back will corrupt in-flight stories.

If all three say "roll back," continue.

## Procedure

### Step 1 — List recent revisions

```bash
gcloud run revisions list --service=storybook-api --region=us-central1 \
  --format='table(metadata.name,metadata.creationTimestamp,status.conditions[0].lastTransitionTime)' \
  --limit=10
```

The currently-serving revision is at the top. The next-most-recent (or any earlier known-good one) is your rollback target. Example revision name: `storybook-api-00125-abc`.

### Step 2 — Route 100% of traffic to the prior revision

```bash
# Replace PRIOR with the known-good revision name.
gcloud run services update-traffic storybook-api --region=us-central1 \
  --to-revisions=PRIOR=100
```

The routing-table shift is instant. **But** because `cloudbuild.yaml` pins `--min-instances=0` (FC-032), the prior revision has likely been scaled to zero. **Expect a 5-15s cold start on the first request.** Pre-warm before claiming the rollback succeeded:

```bash
# Fire 2-3 hits in a row — the first one trips the cold start; subsequent
# requests land on the warm instance.
for i in 1 2 3; do
  curl -sS -o /dev/null -w "warm-up $i: %{http_code} in %{time_total}s\n" \
    https://storybook-api-983903024759.us-central1.run.app/health
done
```

Validate via `gcloud run services describe storybook-api` — the "Traffic" section should show `100%` to PRIOR.

### Step 3 — Smoke test

```bash
# Health endpoint (if it exists; otherwise hit any GET):
curl -sS https://storybook-api-983903024759.us-central1.run.app/health
# Or via a Firebase ID token (replace TOKEN):
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://storybook-api-983903024759.us-central1.run.app/api/stories
```

If responses are healthy, the rollback succeeded.

### Step 4 — Revert the bad commit on main

The Cloud Build trigger fires on every merge to main. If you leave the bad commit on main, the next merge (even an unrelated docs PR) will redeploy the bad revision. So you must revert:

```bash
git revert --no-edit <bad-commit-sha>
git push origin main
```

This triggers a new Cloud Build that deploys a "fixed" revision identical to the rollback target. The traffic routing follows the new deployment automatically.

## Validation

- `gcloud run services describe storybook-api --region=us-central1 --format='value(status.url,status.traffic)'` shows 100% traffic on the intended revision.
- The error rate alert auto-resolves within ~5 min (the alert's `autoClose` is 24h but the underlying metric drops as soon as traffic shifts).
- Real-user requests succeed (check Cloud Run logs for 200s).

## Gotcha: secret bindings

If the bad revision shipped a NEW secret binding (e.g., a new `FOO_API_KEY`), the prior revision doesn't have that binding. Code running on the prior revision will see `process.env.FOO_API_KEY === undefined` and may crash. If this is the case, the rollback is incomplete — you may need to add the secret binding to the prior revision too, OR fix-forward instead.

Check before rolling back:

```bash
gcloud run revisions describe PRIOR --region=us-central1 \
  --format='value(spec.template.spec.containers[0].env[].name)'
gcloud run revisions describe CURRENT --region=us-central1 \
  --format='value(spec.template.spec.containers[0].env[].name)'
```

Diff them. If the lists differ, the rollback may not work cleanly.

## Audit trail

After rollback, document the incident:
- What was the bad commit? Link it.
- What was the user-visible symptom?
- How long was prod broken?
- Why did the FC-032 CI test gate not catch this? (If applicable — file a follow-up to add a regression test.)

Add a line to this file when this runbook is exercised:

- _(blank — no rollbacks yet as of 2026-06-23)_
