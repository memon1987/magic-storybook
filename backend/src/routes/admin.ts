/**
 * FC-017 Phase 4 — admin endpoints invoked by Cloud Scheduler (not by users).
 *
 * Auth: bearer-token via env var `SWEEP_AUTH_TOKEN`. The Cloud Scheduler
 * job is configured with the same secret. Lower-fidelity than OIDC + service
 * accounts but adequate for this Phase 4 MVP and one fewer moving part to
 * provision. The token is stored in Cloud Secret Manager and bound to the
 * Cloud Run service as an env var; never committed.
 *
 * Endpoints:
 *   POST /api/admin/sweep-orphans — find stories whose worker died without
 *     terminal status (status='generating', heartbeat older than threshold),
 *     mark them failed:'orphaned' + clear lock fields so the user sees the
 *     story as failed (with a Resume button) instead of stuck-generating
 *     forever.
 */
import { Router, Request, Response } from 'express';
import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import { timingSafeEqual } from 'node:crypto';
import { FailureCode, StoryDocument } from '../types';

const router = Router();
const db = new Firestore();

// Mark a generating doc as orphaned if its last heartbeat is older than this.
// Set well above the worker's 90s stale-lock threshold so we don't fight an
// in-flight take-over attempt; 5 minutes is conservative for a Phase 2 worker
// whose longest single phase is parallel-pages (~30-60s + retry tail).
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1_000;

/**
 * Static-secret bearer-token check. Returns true if authorized, otherwise
 * writes 401 and returns false (caller should `return`).
 */
function checkSweepAuth(req: Request, res: Response): boolean {
  const token = process.env.SWEEP_AUTH_TOKEN;
  if (!token) {
    console.warn('[FC-017 sweep] SWEEP_AUTH_TOKEN env var not set; endpoint locked');
    res.status(503).json({ error: 'Sweep endpoint not configured' });
    return false;
  }
  const auth = req.header('Authorization');
  // PR-29 MEDIUM-5: constant-time comparison. Strings != is variable-time in
  // V8 (early exit on first mismatched byte); a timing oracle could leak the
  // token character-by-character. Negligible at internet RTT but trivial to
  // fix. Coerce both sides to Buffers of equal length first (timingSafeEqual
  // throws on length mismatch — that's the leak fix's first guard).
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(auth ?? '');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// FC-030 Change 2 — cap each query at 100 docs. Under a regional outage
// that flips many docs to generating/queued at once, we'd otherwise pull
// a massive snapshot and risk exceeding Cloud Scheduler's 180s attempt
// deadline (each per-doc transaction below is ~50-100ms). The next cron
// tick picks up the rest.
const SWEEP_QUERY_LIMIT = 100;

router.post('/sweep-orphans', async (req: Request, res: Response) => {
  if (!checkSweepAuth(req, res)) return;

  try {
    const cutoff = Timestamp.fromMillis(Date.now() - ORPHAN_THRESHOLD_MS);
    const createdCutoff = Timestamp.fromMillis(Date.now() - ORPHAN_THRESHOLD_MS);

    // FC-025/PR-29 HIGH-2: sweep BOTH `status='generating'` (worker started
    // but heartbeat went stale) AND `status='queued'` (worker never started
    // — e.g. process killed between the route's initial set() and the
    // background worker getting picked up by the JS scheduler). The
    // 'generating' case uses workerHeartbeatAt < cutoff; the 'queued'
    // case uses createdAt < cutoff (queued docs never had a heartbeat).
    //
    // Two queries instead of an `in` query so each can hit its own
    // composite index and the heartbeat predicate stays simple.
    const [genSnap, queuedSnap] = await Promise.all([
      db.collection('stories')
        .where('status', '==', 'generating')
        .where('workerHeartbeatAt', '<', cutoff)
        .limit(SWEEP_QUERY_LIMIT)
        .get(),
      db.collection('stories')
        .where('status', '==', 'queued')
        .where('createdAt', '<', createdCutoff)
        .limit(SWEEP_QUERY_LIMIT)
        .get(),
    ]);

    const allDocs = [...genSnap.docs, ...queuedSnap.docs];
    if (allDocs.length === 0) {
      res.json({ swept: 0 });
      return;
    }

    // FC-030 Change 2 — per-doc transactional re-read. Previously a single
    // bulk `batch.update`: the query returned docs whose heartbeat was
    // stale at query time, but between query-prep and the batch.commit
    // (~100-500ms) a `claimLock` takeover could land a fresh heartbeat.
    // The bulk batch then clobbered the takeover's `status='generating'`
    // with `status='failed:orphaned'` AND deleted `workerId`/heartbeat —
    // setting up a split-brain on the next Resume (claimLock saw
    // workerId=undefined and claimed, while the original worker was
    // still running). Two workers on one storyId → success-path batches
    // wrote pages with (formerly) auto-id'd refs → duplicate pages.
    //
    // Per-doc transactions re-read INSIDE the txn and skip if the
    // predicate no longer holds. Combined with FC-030 Change 1
    // (deterministic page IDs), the corruption class is closed both at
    // the race-window-narrowing layer (this) and the idempotency-floor
    // layer (Change 1).
    const ids: string[] = [];
    const failedIds: string[] = [];
    let sweptGenerating = 0;
    let sweptQueued = 0;
    for (const doc of allDocs) {
      try {
        const result = await sweepOrphanTx(db, doc.ref, cutoff.toMillis(), createdCutoff.toMillis());
        if (result === 'generating') sweptGenerating++;
        else if (result === 'queued') sweptQueued++;
        if (result) ids.push(doc.id);
      } catch (err) {
        // FC-030 confirmation review MEDIUM-2: log at ERROR level (not
        // WARN) and surface the failed-doc IDs in the response so a
        // persistent per-doc tx failure becomes a visible signal in
        // Cloud Scheduler's HTTP-response history + Cloud Logging
        // queries. Without this, a doc could fail every sweep tick
        // forever and the only signal is a `console.warn` in logs that
        // no human is paged on.
        console.error(`[FC-017 sweep] Doc ${doc.id} sweep tx failed:`, err);
        failedIds.push(doc.id);
      }
    }

    const sweptTotal = sweptGenerating + sweptQueued;
    const skippedCount = allDocs.length - sweptTotal - failedIds.length;
    console.warn(`[FC-017 sweep] Marked ${sweptTotal} orphan stories failed (${sweptGenerating} generating, ${sweptQueued} queued; ${skippedCount} skipped due to takeover/already-terminal; ${failedIds.length} tx-failures): ${ids.join(', ')}`);
    res.json({
      swept: sweptTotal,
      generating: sweptGenerating,
      queued: sweptQueued,
      skipped: skippedCount,
      txFailures: failedIds.length,
      ids,
      failedIds,
    });
  } catch (error) {
    console.error('[FC-017 sweep] Sweep failed:', error);
    res.status(500).json({
      error: 'Sweep failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * FC-030 — extracted sweep transaction body so tests can exercise the
 * production code path. Pure-ish: takes (db, ref, cutoffs) and returns
 * what kind of doc was swept (or null if the takeover-race aborted us).
 *
 * Predicate: status='generating' AND heartbeat still < cutoff → mark
 * failed:orphaned. status='queued' AND createdAt still < cutoff → mark
 * failed:orphaned. Any other state → no-op (a takeover landed a fresh
 * heartbeat, or the doc has reached a terminal status since the query
 * snapshot was taken).
 */
export async function sweepOrphanTx(
  db: Firestore,
  ref: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
  createdCutoffMs: number,
): Promise<'generating' | 'queued' | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as Partial<StoryDocument>;
    const status = data.status;
    if (status === 'generating') {
      const hb = data.workerHeartbeatAt as Timestamp | undefined;
      // A takeover that landed between query-prep and now refreshed
      // workerHeartbeatAt — we now see the fresh value and abort.
      if (!hb || hb.toMillis() >= cutoffMs) return null;
    } else if (status === 'queued') {
      const created = data.createdAt as Timestamp | undefined;
      if (!created || created.toMillis() >= createdCutoffMs) return null;
    } else {
      // Already terminal (complete/failed); nothing to do.
      return null;
    }
    tx.update(ref, {
      status: 'failed',
      failureReason: 'orphaned' as FailureCode,
      workerId: FieldValue.delete(),
      workerHeartbeatAt: FieldValue.delete(),
    });
    return status as 'generating' | 'queued';
  });
}

export default router;
