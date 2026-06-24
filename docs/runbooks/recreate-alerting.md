# Runbook: recreate the FC-032 alerting from scratch

**Last verified:** 2026-06-23 (initial; first version of policies live in production).

## When to use

- The GCP project is being recreated from scratch (rare; disaster recovery).
- An operator accidentally deleted a policy / metric / channel via the Console.
- You need to extend alerting in a different project (staging / second prod).

## Why this file exists

The FC-032 baseline alerting (2 log-based metrics + 2 monitoring policies + 1 notification channel) was created via `gcloud` one-time on 2026-06-23. The state lives in GCP, not in the repo. If state is lost, this runbook is the recipe to recreate it. Future hardening: Terraform / Config Sync for proper IaC; tracked as a follow-up FC.

## Step 1 — Notification channel (email)

```bash
gcloud beta monitoring channels create \
  --display-name="zeshan@tkzmgroup.com (FC-017 alerts)" \
  --type=email \
  --channel-labels=email_address=zeshan@tkzmgroup.com
# Capture the channel name from the output (`projects/.../notificationChannels/N`).
```

Store the channel name; the policies below reference it.

## Step 2 — Log-based metrics

Two metrics, both severity≥ERROR filters scoped to the relevant resource.

```bash
gcloud logging metrics create sweep_failures \
  --description="Cloud Scheduler sweep-orphans job failures (FC-017)" \
  --log-filter='resource.type="cloud_scheduler_job" AND resource.labels.job_id="sweep-orphans" AND severity>=ERROR'

gcloud logging metrics create storybook_api_errors \
  --description="storybook-api Cloud Run errors (FC-017)" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="storybook-api" AND severity>=ERROR'

gcloud logging metrics create cloud_build_failures \
  --description="Cloud Build failed deploys (FC-032)" \
  --log-filter='resource.type="build" AND severity>=ERROR AND jsonPayload.status="FAILURE"'
```

**Gotcha:** newly-created log-based metrics take ~1-10 min to become queryable. If the policy-create step below fails with `Cannot find metric(s) that match type = "logging.googleapis.com/user/<name>"`, wait 30s-2min and retry. The `until/sleep` loop in the audit trail at the bottom of this file is the recipe.

## Step 3 — Monitoring policies

Each policy is a YAML file; create via `gcloud monitoring policies create --policy-from-file=…`.

### `sweep-alert.yaml`

```yaml
displayName: "FC-017 sweep-orphans job ERROR"
documentation:
  content: |
    The Cloud Scheduler job 'sweep-orphans' logged a severity>=ERROR entry.
    Runbook: docs/runbooks/sweep-job-failing.md
  mimeType: text/markdown
combiner: OR
conditions:
  - displayName: "sweep-orphans error in last 10 min"
    conditionThreshold:
      filter: |-
        resource.type = "cloud_scheduler_job"
        AND metric.type = "logging.googleapis.com/user/sweep_failures"
      comparison: COMPARISON_GT
      thresholdValue: 0
      duration: 0s
      aggregations:
        - alignmentPeriod: 600s
          perSeriesAligner: ALIGN_SUM
notificationChannels:
  - projects/ai-storybook-app-2025/notificationChannels/<CHANNEL_NAME_FROM_STEP_1>
alertStrategy:
  autoClose: 86400s
enabled: true
```

Threshold: ANY sweep error in a 10-minute window → page. The sweep should never error in normal operation, so threshold=0 is appropriate.

### `cloud-run-errors.yaml`

```yaml
displayName: "storybook-api error rate"
documentation:
  content: |
    Cloud Run service 'storybook-api' logged severity>=ERROR entries.
    Runbook: docs/runbooks/cloud-run-oom-response.md (runtime)
            docs/runbooks/cloud-build-failed.md (post-deploy regression)
  mimeType: text/markdown
combiner: OR
conditions:
  - displayName: "Cloud Run errors >5/5min sustained"
    conditionThreshold:
      filter: |-
        resource.type = "cloud_run_revision"
        AND metric.type = "logging.googleapis.com/user/storybook_api_errors"
      comparison: COMPARISON_GT
      thresholdValue: 5
      duration: 300s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
notificationChannels:
  - projects/ai-storybook-app-2025/notificationChannels/<CHANNEL_NAME_FROM_STEP_1>
alertStrategy:
  autoClose: 86400s
enabled: true
```

Threshold: >5 errors in 5min sustained → page. Suppresses single-event noise; catches sustained issues.

### `cloud-build-failed.yaml` (optional but recommended; not yet shipped to prod as of 2026-06-23)

```yaml
displayName: "Cloud Build deploy failure (storybook-api)"
documentation:
  content: |
    A Cloud Build deploy of storybook-api failed. The previous Cloud Run
    revision keeps serving; new code is NOT live.
    Runbook: docs/runbooks/cloud-build-failed.md
  mimeType: text/markdown
combiner: OR
conditions:
  - displayName: "Cloud Build status=FAILURE in last 30 min"
    conditionThreshold:
      filter: |-
        resource.type = "build"
        AND metric.type = "cloudbuild.googleapis.com/build/count"
        AND metric.labels.status = "FAILURE"
      comparison: COMPARISON_GT
      thresholdValue: 0
      duration: 0s
      aggregations:
        - alignmentPeriod: 1800s
          perSeriesAligner: ALIGN_SUM
notificationChannels:
  - projects/ai-storybook-app-2025/notificationChannels/<CHANNEL_NAME_FROM_STEP_1>
alertStrategy:
  autoClose: 86400s
enabled: true
```

## Step 4 — Verify

```bash
gcloud monitoring policies list --format='value(displayName,enabled)'
gcloud logging metrics list --format='value(name)'
gcloud beta monitoring channels list --format='value(displayName,type)'
```

Expected (after Step 3):
- 2 (or 3) policies enabled.
- 2 log-based metrics.
- 1 email channel.

## Live state inventory (as of 2026-06-24)

| Resource | Name | Status |
|---|---|---|
| Notification channel | `projects/ai-storybook-app-2025/notificationChannels/3857053775445793418` (email → zeshan@tkzmgroup.com) | Active |
| Log metric | `sweep_failures` | Active |
| Log metric | `storybook_api_errors` | Active |
| Log metric | `cloud_build_failures` | Active (created 2026-06-24) |
| Alert policy | `FC-017 sweep-orphans job ERROR` | Enabled |
| Alert policy | `storybook-api error rate` | Enabled |
| Alert policy | `Cloud Build deploy failure (storybook-api)` | Enabled (created 2026-06-24, policy id `4842171722136950381`) |

## First-24-hours owner

Whoever owns alert-quality iteration for the first 24h: **Zeshan (no one else with prod access).** Tune thresholds based on observed false-positive rate; document tuning here.

## Audit trail

- 2026-06-23 — initial creation of sweep + Cloud Run policies + log metrics + email channel.
- 2026-06-24 — added `cloud_build_failures` log-based metric + `Cloud Build deploy failure (storybook-api)` policy. The policy create initially failed with `Cannot find metric(s) that match type = "logging.googleapis.com/user/cloud_build_failures"` because the metric needs ~1-10 min to propagate. Resolved by polling:
  ```bash
  until gcloud monitoring policies create --policy-from-file=cloud-build-failed.yaml 2>&1 | grep -qE "^Created|already exists"; do sleep 30; done
  ```
