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

const storage = new Storage();
const bucketName = process.env.STORAGE_BUCKET!;
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
    const file = bucket.file(name);
    const [buffer] = await file.download();
    const [meta] = await file.getMetadata();
    const mimeType = (typeof meta.contentType === 'string' && meta.contentType)
      || (name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
    return { data: buffer.toString('base64'), mimeType };
  } catch (e) {
    console.warn(`[FC-017 resume] Failed to re-download ref from ${publicUrl}:`, e);
    return null;
  }
}
