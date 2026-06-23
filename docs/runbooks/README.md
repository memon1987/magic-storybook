# Operational runbooks

Created 2026-06-23 as part of FC-032 (ops floor baseline) — closes R3 H-1 from the FC-017 retrospective ("zero runbooks for any of the 12 operational scenarios audited"). Each runbook is a short, executable playbook for a specific incident class.

## How to use

When an alert fires (or a customer reports a problem), find the matching runbook and follow it. Each runbook is structured:
- **Symptom** — what you'd see (log line, alert email, user complaint).
- **Diagnosis** — exact commands to run, what to look for.
- **Resolution** — exact remediation steps.
- **Validation** — how to confirm it worked.
- **Last verified** — date the runbook was tested end-to-end. **Update this date whenever you actually run through the steps and they work** — stale runbooks worse than no runbooks.

If you hit a scenario without a runbook here, write one as you debug. The pattern is: a fresh engineer on-call at 3am should be able to follow it without prior context.

## Index

| # | Runbook | Used when |
|---|---|---|
| 1 | [sweep-job-failing.md](sweep-job-failing.md) | `FC-017 sweep-orphans job ERROR` alert fires |
| 2 | [secret-rotation.md](secret-rotation.md) | Rotating `SWEEP_AUTH_TOKEN` or `GEMINI_API_KEY` |
| 3 | [cloud-run-rollback.md](cloud-run-rollback.md) | Bad deploy needs to roll back |
| 4 | [story-stuck-generating.md](story-stuck-generating.md) | User reports a story stuck in `generating` |
| 5 | [story-manual-resume.md](story-manual-resume.md) | Admin needs to manually re-fire the worker |
| 6 | [firestore-data-restore.md](firestore-data-restore.md) | Restoring from PITR or daily backup |
| 7 | [cloud-build-failed.md](cloud-build-failed.md) | Merge-to-main triggered a failed deploy |
| 8 | [cloud-run-oom-response.md](cloud-run-oom-response.md) | `storybook-api error rate` alert fires |

Deferred (file as needs arise):
- `gemini-api-outage.md` — Gemini-wide outage; current playbook is just "wait" + maybe pause new generates if extended.
- `quota-breach.md` — Gemini RPM / Firestore writes/sec quota approach.
- `firestore-index-rebuild.md` — needed only on schema changes.
- `mass-failure-incident-triage.md` — meta-runbook for "everything is on fire at once."
