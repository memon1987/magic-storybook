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
import { FailureCode } from '../types';

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
        .get(),
      db.collection('stories')
        .where('status', '==', 'queued')
        .where('createdAt', '<', createdCutoff)
        .get(),
    ]);

    const allDocs = [...genSnap.docs, ...queuedSnap.docs];
    if (allDocs.length === 0) {
      res.json({ swept: 0 });
      return;
    }

    const batch = db.batch();
    const ids: string[] = [];
    for (const doc of allDocs) {
      ids.push(doc.id);
      batch.update(doc.ref, {
        status: 'failed',
        failureReason: 'orphaned' as FailureCode,
        workerId: FieldValue.delete(),
        workerHeartbeatAt: FieldValue.delete(),
      });
    }
    await batch.commit();
    console.warn(`[FC-017 sweep] Marked ${allDocs.length} orphan stories failed (${genSnap.size} generating, ${queuedSnap.size} queued): ${ids.join(', ')}`);
    res.json({ swept: allDocs.length, generating: genSnap.size, queued: queuedSnap.size, ids });
  } catch (error) {
    console.error('[FC-017 sweep] Sweep failed:', error);
    res.status(500).json({
      error: 'Sweep failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
