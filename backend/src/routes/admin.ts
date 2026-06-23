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
  if (auth !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

router.post('/sweep-orphans', async (req: Request, res: Response) => {
  if (!checkSweepAuth(req, res)) return;

  try {
    const cutoff = Timestamp.fromMillis(Date.now() - ORPHAN_THRESHOLD_MS);
    // Requires a composite index on (status ASC, workerHeartbeatAt ASC).
    // Firestore prints a one-click link on the first call if it's missing.
    const snapshot = await db
      .collection('stories')
      .where('status', '==', 'generating')
      .where('workerHeartbeatAt', '<', cutoff)
      .get();

    if (snapshot.empty) {
      res.json({ swept: 0 });
      return;
    }

    const batch = db.batch();
    const ids: string[] = [];
    for (const doc of snapshot.docs) {
      ids.push(doc.id);
      batch.update(doc.ref, {
        status: 'failed',
        failureReason: 'orphaned' as FailureCode,
        workerId: FieldValue.delete(),
        workerHeartbeatAt: FieldValue.delete(),
      });
    }
    await batch.commit();
    console.warn(`[FC-017 sweep] Marked ${snapshot.size} orphan stories failed: ${ids.join(', ')}`);
    res.json({ swept: snapshot.size, ids });
  } catch (error) {
    console.error('[FC-017 sweep] Sweep failed:', error);
    res.status(500).json({
      error: 'Sweep failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
