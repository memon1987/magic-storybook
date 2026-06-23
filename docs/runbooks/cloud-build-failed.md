# Runbook: Cloud Build deploy failed after merge to main

**Last verified:** 2026-06-23 (FC-032 added the CI test gate that this runbook complements).

## Symptom

You merged a PR to main. A few minutes later, instead of seeing the new behavior live, you see... the OLD behavior. OR the `storybook-api error rate` alert fires shortly after the merge.

## Diagnosis

1. **Confirm Cloud Build status:**
   ```bash
   gcloud builds list --limit=5 \
     --format='table(id,status,createTime,duration,source.repoSource.commitSha)'
   ```
   Look for the latest build matching your commit SHA. `STATUS` should be `SUCCESS`. Common failures:
   - `FAILURE` — a step exit'd non-zero. Drill in:
     ```bash
     gcloud builds describe <BUILD_ID> --format='value(steps[].name,steps[].status)'
     gcloud builds log <BUILD_ID> | tail -100
     ```
   - `TIMEOUT` — build exceeded the timeout (default 1h). For us this should NEVER happen; investigate.
   - `CANCELLED` — someone (you or another build trigger) cancelled. Re-merge or re-trigger.

2. **Which step failed?**
   - **Tests (FC-032 CI test gate, the new `npm test` step)** — broken tests; revert the bad commit or fix-forward immediately. The CI gate did its job.
   - **Image build** — Dockerfile or dependency issue. Look at `npm ci` output, `tsc` output, or Docker layer caching issues.
   - **Image push** — Artifact Registry quota or permissions issue. Rare.
   - **Deploy** — Cloud Run rejected the new revision (e.g., container failed health checks at startup). The previous revision keeps serving.

## Common causes + Resolution

### Cause A — Tests broken in main (new since FC-032)
The PR author's local `vitest run` passed but CI failed. Common: env-var-load-time dependency, async race in a test that's flaky on slower CI nodes.

**Resolution:** identify the test. Either revert (`git revert <commit>; git push origin main`) which auto-triggers a deploy of the prior-known-good code, OR fix-forward with a one-line commit.

### Cause B — TypeScript compile error in main
The PR author had a stale local tsc cache. CI build runs fresh.

**Resolution:** fix-forward; tsc errors are fast to chase.

### Cause C — Container startup failure (deploy step)
Cloud Run health-checks the new revision; if it fails, Cloud Run keeps traffic on the prior revision. Most common cause: missing env var that the new revision needs to start (e.g., a new required `process.env.FOO` without a default).

```bash
gcloud run revisions describe <NEW_REV> --region=us-central1 \
  --format='value(status.conditions[].type,status.conditions[].message)'
```

**Resolution:** add the env var binding (via `--set-env-vars` or Secret Manager + `--update-secrets`) OR fix-forward to remove the dependency on the missing var.

### Cause D — Image push permission drift
Rare. Cloud Build SA needs `roles/artifactregistry.writer` on the registry.

```bash
gcloud projects get-iam-policy ai-storybook-app-2025 \
  --flatten='bindings[].members' \
  --filter='bindings.members:cloudbuild' \
  --format='value(bindings.role)'
```

**Resolution:** restore the binding; redeploy.

## Validation

- `gcloud builds list --limit=1` shows your fix-forward / revert commit with `SUCCESS`.
- The new Cloud Run revision is serving 100% of traffic.
- Smoke-test the affected functionality.

## Prevention

- FC-032's CI test gate catches test failures BEFORE deploy. If it didn't catch a class of failure, file a follow-up to extend test coverage.
- Consider adding a startup probe (Cloud Run `--startup-probe` flag) to fail fast on missing env vars instead of letting requests time out.
