# Runbook: manually trigger a Resume on a story

**Last verified:** 2026-06-23 (initial; not yet exercised).

## When to use

- A user reports `safety_blocked` for an obviously-benign prompt and you want to retry without making them re-enter the inputs (FC-031 caps Resume from the mobile UI to 3 attempts; this is the admin override).
- You manually unsticked a doc via [story-stuck-generating.md](story-stuck-generating.md) Cause D and the user isn't online to tap Resume.
- Validating that resume works end-to-end after a deploy.

## Procedure

The resume endpoint requires a Firebase ID token for the doc's owner. You DON'T have that token; you can't impersonate a user. The supported paths are:

### Path A — Walk the user through tapping Resume themselves (preferred)

Tell them to open the story from their library and tap "Try again." This is the documented flow.

### Path B — Use an admin token (requires Firebase Admin SDK + ADC)

Only do this if Path A isn't available. The committed helper `backend/scripts/mint-spike-token.js` reads the story's owner uid from Firestore, mints a Firebase custom token signed by the firebase-adminsdk SA, exchanges it for an ID token via the Identity Toolkit REST API, and prints the ID token to stdout.

**Prerequisites:**
- Local machine has `gcloud auth application-default login` done as a user with `roles/iam.serviceAccountTokenCreator` on `firebase-adminsdk-fbsvc@ai-storybook-app-2025.iam.gserviceaccount.com`.
- Knowledge of the Firebase Web API key (env var `EXPO_PUBLIC_FIREBASE_API_KEY` in `mobile/eas.json`; not secret — designed-public Firebase config).

**Run:**
```bash
cd backend
WEB_API_KEY="<from-mobile/eas.json>"
ID_TOKEN=$(node scripts/mint-spike-token.js STORY_ID "$WEB_API_KEY")
curl -sS -X POST -H "Authorization: Bearer $ID_TOKEN" \
  https://storybook-api-983903024759.us-central1.run.app/api/stories/STORY_ID/resume
```

Expected: `202 {"storyId":"STORY_ID","status":"queued"}`.

### Path C — Direct doc edit + worker self-fires (NOT recommended)

This skips the normal lock-claim path and risks split-brain. Don't do this unless you understand FC-030's race fixes.

## Validation

After Resume:
1. Cloud Run logs show `[story:$ID] runStoryWorker entered` within ~1s.
2. Doc's `attempt` incremented.
3. Doc's `workerId`/`workerHeartbeatAt` refreshed.
4. Within ~3-5 min, doc flips to `complete` OR `failed` with a fresh `failureReason`.

## Gotchas

- **Resume burns Gemini cost.** Each resume re-runs only the missing phases (Phase 2 checkpoints) but if a `generateStory` retry is needed, that's ~$0.05; full char-ref regen is ~$0.20-$0.50; full page regen is ~$0.50-$1.10.
- **Resume can't recover a doc whose `userId` is wrong.** The `/api/stories/:id/resume` route rejects mismatched ownership with 403 (search `backend/src/routes/stories.ts` for `Access denied`). If the doc's userId is corrupted, fix the doc first.
