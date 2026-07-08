/**
 * FC-017 Phase 3+4: live story-doc subscription via Firestore onSnapshot.
 *
 * The 202-ACK contract (POST /generate, POST /:id/resume) returns just
 * `{ storyId, status }`. Mobile uses subscribeToStory() to observe the
 * doc's progress field + terminal status. This is the silent-success bug
 * fix: previously the mobile axios timeout was the source of truth for
 * "did this generation finish?", and on timeout the backend kept running,
 * finished, and saved the story while the user saw an error. Now the
 * doc is the source of truth and the snapshot fires per phase commit.
 *
 * Firestore Security Rules requirement (deploy via Firebase Console):
 *     match /stories/{id} {
 *       allow read: if request.auth != null && request.auth.uid == resource.data.userId;
 *     }
 * Without this, the subscription throws permission-denied at first event.
 */
import { doc, onSnapshot, Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import type { StoryStatus, FailureCode, GenerationProgress } from './api';

export interface StorySnapshot {
  id: string;
  status: StoryStatus;
  title?: string;
  progress?: GenerationProgress;
  failureReason?: FailureCode;
  // FC-031 Change 6(a): claim counter, used by the /generating screen
  // to enforce the retry budget (cap auto-Resume at 3 attempts on a
  // failed story).
  attempt?: number;
  // FC-036: explicit fields for the determinate progress model on the
  // /generating screen (mobile/utils/storyProgress.ts).
  childName?: string;
  length?: 'short' | 'medium' | 'long';
  // FC-025 B-6 flags — the only observable signal that cast/title
  // generation finished (no `saveProgress` call ever writes the 'cast'
  // or 'title' phases).
  castAttempted?: boolean;
  titleAttempted?: boolean;
  // Size of the doc's `pageUrls` map (one key per completed page).
  // Deliberately a COUNT: the page image URLs themselves never cross
  // into the UI, so the loading screen can't spoil the story.
  pageUrlsCount?: number;
  // Other fields exist on the doc but the generating screen + library
  // only need the shape above. If additional rendering needs arise,
  // extend this shape — don't spread the raw doc to avoid renderers
  // reaching for internal fields like workerId or storyText.
}

export type StorySubscriptionResult = StorySnapshot | { error: 'not_found' | 'permission_denied' | 'unknown' };

/**
 * Subscribe to live updates on a single story doc. Calls `onUpdate` with
 * the latest snapshot on every change (typically per-phase commit + once
 * on initial connect). Returns an unsubscribe function — caller MUST call
 * it on unmount to avoid Firestore quota burn.
 *
 * Failure modes:
 *   - Doc doesn't exist: `{ error: 'not_found' }`. Caller should navigate
 *     back to the library.
 *   - Firestore Security Rules deny read: `{ error: 'permission_denied' }`.
 *     Means the rules aren't deployed or the user doesn't own this doc.
 *   - Other errors: `{ error: 'unknown' }`. Caller renders a generic error
 *     + Retry / Back-to-library affordances.
 */
export function subscribeToStory(
  id: string,
  onUpdate: (result: StorySubscriptionResult) => void,
): Unsubscribe {
  const ref = doc(db, 'stories', id);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onUpdate({ error: 'not_found' });
        return;
      }
      const data = snap.data();
      onUpdate({
        id: snap.id,
        status: data.status as StoryStatus,
        title: data.title,
        progress: data.progress as GenerationProgress | undefined,
        failureReason: data.failureReason as FailureCode | undefined,
        attempt: data.attempt as number | undefined,
        // FC-036 progress-model fields (see StorySnapshot comments).
        childName: data.childName as string | undefined,
        length: data.length as 'short' | 'medium' | 'long' | undefined,
        castAttempted: data.castAttempted as boolean | undefined,
        titleAttempted: data.titleAttempted as boolean | undefined,
        pageUrlsCount: Object.keys((data.pageUrls as Record<string, unknown> | undefined) ?? {}).length,
      });
    },
    (err) => {
      const code = (err as { code?: string }).code;
      console.warn(`[FC-017] Story subscription error for ${id}:`, code, err.message);
      if (code === 'permission-denied') {
        onUpdate({ error: 'permission_denied' });
      } else {
        onUpdate({ error: 'unknown' });
      }
    },
  );
}
