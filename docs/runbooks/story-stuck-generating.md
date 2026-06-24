# Runbook: a single story is stuck in `generating`

**Last verified:** 2026-06-23 (initial; not yet exercised).

## Symptom

A customer reports a story has been "Generating…" for >15 min and the Resume button hasn't appeared. They can see the row in their library.

## Diagnosis

1. **Get the storyId** — ask the customer to long-press the row → Share → look at the URL fragment, OR look it up by their `userId` in Firestore Console:
   `https://console.firebase.google.com/project/ai-storybook-app-2025/firestore/data/~2Fstories` → filter by `userId == <uid>` sort by `createdAt` desc.

2. **Inspect the doc** (`gcloud firestore` has no `documents read` subcommand; use one of these instead):

   **Option A — Firebase Console (easiest, no setup):**
   `https://console.firebase.google.com/project/ai-storybook-app-2025/firestore/data/~2Fstories~2FSTORY_ID`
   (URL-encode `/` as `~2F`).

   **Option B — Node one-liner from a machine with `gcloud auth application-default login`:**
   ```bash
   node -e "const{Firestore}=require('@google-cloud/firestore');
     (async()=>{const d=await new Firestore().doc('stories/STORY_ID').get();
     console.log(JSON.stringify(d.data(),null,2));})()"
   ```
   Run from `backend/` so `@google-cloud/firestore` resolves.

   Fields to check:
   - `status` — `generating` confirms the symptom; if `failed` or `complete`, the user is on a stale snapshot.
   - `workerId` — should be set; format `<K_REVISION>-<uuid>`.
   - `workerHeartbeatAt` — should be < 90s old for a live worker. If older, the worker is dead.
   - `progress.phase` + `progress.updatedAt` — last phase the worker reached.
   - `attempt` — how many times the worker has been claimed.

3. **Check Cloud Run logs for this storyId:**
   ```bash
   gcloud run services logs read storybook-api --region=us-central1 --limit=200 \
     | grep "\[story:$STORY_ID\]"
   ```
   Look for the last log line — was the worker mid-Gemini call when it stopped? Is there a stack trace?

## Common causes + Resolution

### Cause A — Worker is alive and slow (Gemini tail latency)
If `workerHeartbeatAt` is fresh (<90s) AND `progress.updatedAt` is advancing, the worker is alive but a Gemini call is taking a long time. Common during regional Gemini issues. Tell the customer to wait; don't intervene.

### Cause B — Worker died, sweep hasn't fired yet
`workerHeartbeatAt` is stale (>90s) but the doc is still `generating`. The sweep runs every 10 min; worst case the doc flips to `failed:orphaned` within 15 min of death. **Wait for the sweep** — see [sweep-job-failing.md](sweep-job-failing.md) to verify the sweep itself is healthy.

### Cause C — Sweep is broken
`workerHeartbeatAt` is stale, multiple cron ticks have passed, and doc is still `generating`. Run [sweep-job-failing.md](sweep-job-failing.md) end-to-end to fix the sweep. The doc will be picked up on the next successful tick.

### Cause D — Manual unstick (rare; document why before doing this)
If the customer is impatient and the sweep is broken (or won't recover within an acceptable time), manually flip the doc to `failed:orphaned`. There's no `gcloud firestore documents` subcommand — use the Firebase Console:

1. Open `https://console.firebase.google.com/project/ai-storybook-app-2025/firestore/data/~2Fstories~2FSTORY_ID`.
2. Edit fields: set `status='failed'`, `failureReason='orphaned'`; delete the `workerId` and `workerHeartbeatAt` fields entirely (the × icon next to each).
3. Save.

Or via Node (must run from `backend/` with ADC):
```bash
node -e "const{Firestore,FieldValue}=require('@google-cloud/firestore');
  (async()=>{await new Firestore().doc('stories/STORY_ID').update({
    status:'failed',failureReason:'orphaned',
    workerId:FieldValue.delete(),workerHeartbeatAt:FieldValue.delete()});
  console.log('unstuck');})()"
```

Tell the customer to refresh the library; they'll see a Resume button.

## Validation

After the doc flips to `failed`, the customer's mobile `onSnapshot` fires → Resume button appears. They tap → new worker claims → fresh `attempt`. Confirm via logs: `[story:$ID] runStoryWorker entered`.

## Prevention

If you've manually-unstuck >3 stories in a week, the sweep is unreliable or the worker is OOMing repeatedly. Drill into root cause via [cloud-run-oom-response.md](cloud-run-oom-response.md).
