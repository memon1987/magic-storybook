/**
 * FC-017 Phase 2 — re-download a Cloud Storage object back into base64 +
 * mime type so it can be used as a multimodal reference in downstream
 * Gemini calls. Used on resume: a worker picking up a partially-done job
 * reads the GCS URLs from the Firestore doc and re-hydrates the bytes
 * its in-process predecessor had in memory.
 *
 * Cost: ~50ms per ref on typical objects (600KB-1MB). Negligible vs the
 * ~5-30s a regenerated char-ref would cost.
 */

import { Storage } from '@google-cloud/storage';

// FC-025 L-1: previously used `process.env.STORAGE_BUCKET!`, which silently
// resolved to undefined at runtime if the env var was missing — making every
// resume rehydrate fail and the URL prefix at L#26 become
// "https://storage.googleapis.com/undefined/" (matches nothing, every download
// returns null, every resume regenerates from scratch, cost amplification).
// Throw at module load instead so misconfiguration fails loudly.
const bucketName = process.env.STORAGE_BUCKET;
if (!bucketName) {
  throw new Error('STORAGE_BUCKET env var is required for FC-017 resume rehydrate');
}
const storage = new Storage();
const bucket = storage.bucket(bucketName);

/**
 * Parse the GCS object name out of a public URL of the form
 * `https://storage.googleapis.com/${bucket}/${name}`.
 * Returns null if the URL is not a public GCS URL for our bucket
 * (e.g. a `placehold.co` placeholder from a failed generation).
 */
function gcsObjectName(publicUrl: string): string | null {
  const prefix = `https://storage.googleapis.com/${bucketName}/`;
  if (!publicUrl.startsWith(prefix)) return null;
  return publicUrl.slice(prefix.length);
}

/**
 * FC-041: is this URL an object in OUR GCS bucket (vs. a non-bucket URL like a
 * `placehold.co` placeholder)? Load-bearing for the vision-moderation gate:
 * downloadRef returns null for BOTH a non-bucket placeholder (benign — skip)
 * AND an our-bucket object whose download threw (an INFRA failure — must NOT
 * be silently skipped, or an unsafe child-facing image could reach 'complete'
 * unmoderated when its download flakes). The gate uses this predicate to tell
 * the two null cases apart: a non-bucket URL is a real skip; an our-bucket URL
 * that fails to download is a fail-closed infra error.
 */
export function isOurBucketUrl(publicUrl: string): boolean {
  return gcsObjectName(publicUrl) !== null;
}

export interface DownloadedRef {
  data: string;      // base64-encoded image bytes
  mimeType: string;  // 'image/png' or 'image/jpeg'
}

/**
 * Download an uploaded image back into base64 + mime type.
 * Returns null on placeholder URLs (not our bucket) or download failure
 * (so the caller can degrade gracefully: page generation skips the ref).
 */
export async function downloadRef(publicUrl: string): Promise<DownloadedRef | null> {
  const name = gcsObjectName(publicUrl);
  if (!name) return null;
  try {
    // FC-025 efficiency: previously called getMetadata() AFTER download() —
    // two round-trips per ref. The bucket only ever stores image/png or
    // image/jpeg (see uploadGeneratedImage in gemini.ts which always sets
    // one of those), so extension-based inference is sufficient. Single
    // round-trip; ~halves rehydrate latency.
    const file = bucket.file(name);
    const [buffer] = await file.download();
    const mimeType = name.endsWith('.jpg') || name.endsWith('.jpeg')
      ? 'image/jpeg'
      : 'image/png';
    return { data: buffer.toString('base64'), mimeType };
  } catch (e) {
    console.warn(`[FC-017 resume] Failed to re-download ref from ${publicUrl}:`, e);
    return null;
  }
}
