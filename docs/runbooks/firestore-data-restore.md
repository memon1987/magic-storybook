# Runbook: restoring Firestore data from PITR or daily backup

**Last verified:** 2026-06-23 (PITR + backup schedule enabled; restore path not yet exercised against a real corruption).

## When to use

- A buggy admin script or migration corrupted production docs.
- A discovered code regression silently wrote null/wrong values to many docs (e.g., the FC-025 B-4 nested-`serverTimestamp` footgun class).
- A user reports their stories disappeared (need to determine if it's the user's account vs. the data).

## Two restore mechanisms

1. **PITR (point-in-time recovery)** — enabled 2026-06-23 via FC-032 ops actions. Restore to any point in the last **7 days**, at second-level granularity. Best for "the corruption happened at T, restore to T-1s." Costs: standard Firestore read rates against the historical snapshot.

2. **Daily backups** — scheduled daily at the default time, 7-day retention. Coarser-grained than PITR but lower cost. Best for "the corruption happened yesterday but I just noticed."

## Decision tree

1. **How much data is corrupted?** One doc → manually fix it (use Firebase Console; don't restore). Multiple docs in one collection → use PITR scoped to that collection. Whole database → use a daily backup → fresh database, then re-cut traffic.

2. **When did the corruption start?** <7 days ago → PITR works. >7 days → backups; if no backup is old enough, restore is impossible (file an internal note + accept the loss).

3. **Is the bug still in production?** YES → fix-forward FIRST (revert the bad code) or you'll re-corrupt on the next write. Only restore AFTER the bug is gone.

## Procedure (PITR — selective collection restore)

PITR can only do a "read at a point in time" — you query the historical snapshot and write the data back into the current database manually. For the `stories` collection:

```bash
# 1. Identify the timestamp BEFORE the corruption (use NoSQL Workbench or
#    a backend script that does `db.runTransaction({ readTime: TS }, ...)`).
RESTORE_AT="2026-06-22T18:00:00Z"

# 2. Use the Admin SDK's readTime option to read each stories doc as it
#    was at RESTORE_AT, then write back to current. There's no gcloud
#    one-liner for this; write a one-off Node script using
#    @google-cloud/firestore's getAll() with a readTime option.
```

**There is no built-in `gcloud firestore pitr restore-collection` command.** You'll need a custom Node script. Template:

```javascript
const {Firestore} = require('@google-cloud/firestore');
const db = new Firestore();
const READ_TIME = new Date('2026-06-22T18:00:00Z');
// Iterate corrupted doc IDs (from a separate query against current state).
const ids = [/* corrupted doc IDs */];
for (const id of ids) {
  const ref = db.collection('stories').doc(id);
  const snap = await ref.get({readTime: READ_TIME});
  if (!snap.exists) {
    console.warn(`Doc ${id} did not exist at READ_TIME; skipping`);
    continue;
  }
  await ref.set(snap.data());  // overwrites current with historical
  console.log(`Restored ${id}`);
}
```

Test against a single doc first; verify the restored state matches expectations; then run the batch.

## Procedure (daily backup — whole-database restore)

```bash
# 1. List backups
gcloud firestore backups list --location=us-central1

# 2. Restore a backup INTO A NEW DATABASE (you can't overwrite '(default)' in place)
BACKUP_NAME="projects/ai-storybook-app-2025/locations/us-central1/backups/<BACKUP_ID>"
gcloud firestore databases restore \
  --source-backup=$BACKUP_NAME \
  --destination-database=restore-staging
```

The restored data lands in a NEW database (`restore-staging`). To make it production:

```bash
# 3. Validate the restored database has what you expect (Firebase Console
#    or gcloud firestore documents list --database=restore-staging stories).
# 4. THIS IS THE DANGEROUS STEP. You can't atomically swap databases.
#    Options:
#    a. App-level: update mobile + backend env to point at restore-staging.
#       Requires a deploy + EAS build.
#    b. Data-level: copy from restore-staging back into (default), which is
#       essentially manual since there's no gcloud copy command. Use the
#       Admin SDK script pattern above with READ_TIME approach but
#       reading from restore-staging instead.
```

**The whole-database restore is genuinely disruptive.** Avoid unless absolutely necessary. PITR + selective is almost always better.

## Validation

- Sample 5-10 restored docs; verify their content matches expectations.
- For story docs: confirm `pages` subcollection is also restored (subcollections come with the parent under PITR/backup; verify).
- Check the corruption query (the one you used to identify the bad docs in step 1) no longer returns the restored docs.

## Audit trail

After every restore, log:
- What was corrupted? How was it found?
- What was the read-time / backup-time chosen?
- Which doc IDs were touched?
- What downstream effects (users with active sessions during the restore)?

Add to this file (in addition to release notes):

- _(blank — no restores yet as of 2026-06-23)_
