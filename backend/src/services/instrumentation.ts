/**
 * Phase 1 instrumentation shared by FC-016 (latency) and FC-017 (reliability).
 * See the Coordination section of each plan: this module is the single shared
 * instrumentation PR that satisfies both Phase 1 exit criteria at once.
 *
 * What it gives us (non-behavioral — only emits structured JSON log lines):
 *  - `emitStageEvent`  per-stage wall-clock + memory snapshot for FC-016 p50/p95
 *    decomposition and FC-017 root-cause-of-instance-death analysis.
 *  - `emitCallEvent`   per-Gemini-call outcome (success or failure) with
 *    timing + classified error so we can separate `fetch failed` (network
 *    reset) from a 503 (Gemini overload) from a 500 (Gemini internal). FC-017
 *    Phase 1 explicitly calls this out: today we lose what specifically
 *    failed and how long the failed call took before throwing.
 *  - `instrumentedGenerateContent` is the thin async wrapper each generation
 *    function uses around its `ai.models.generateContent` call.
 *  - `classifyError` turns an unknown thrown error into a stable
 *    `errorClass` + optional `statusCode` so the events are queryable in
 *    Cloud Logging by class.
 *  - `storyTag` is the `[story:${id}]` prefix for free-text logs so a dying
 *    instance's logs are traceable to a request.
 *
 * Log shape (single-line JSON, queryable via Cloud Logging on jsonPayload):
 *   { event: 'stage_done' | 'call', ts, storyId, ... }
 */

export type Stage =
  | 'story_text'             // generateStory end-to-end
  | 'char_ref'               // one character reference (success or placeholder)
  | 'char_refs_total'        // entire parallel char-ref batch
  | 'cast_ref'               // cast lineup
  | 'title_page'             // title page
  | 'page'                   // one page including OCR-verify retries
  | 'anchor_pages_total'     // entire sequential anchor batch
  | 'parallel_pages_total'   // entire bounded-concurrency parallel batch
  | 'all_illustrations'      // generateAllIllustrations end-to-end
  | 'firestore_persist'      // batch.commit in the route
  | 'total';                 // whole route handler end-to-end

export type CallKind = 'story_text' | 'char_ref' | 'cast_ref' | 'title_page' | 'page';

export interface StageEvent {
  storyId: string;
  stage: Stage;
  latencyMs: number;
  pageCount?: number;
  charCount?: number;
  attempts?: number;
  retries5xx?: number;
  outcome?: 'success' | 'partial' | 'failure';
  detail?: Record<string, unknown>;
}

export interface CallEvent {
  storyId: string;
  kind: CallKind;
  attempt: number;
  outcome: 'success' | 'failure';
  latencyMs: number;
  statusCode?: number;
  errorClass?: string;
}

function memorySnapshot(): { rssMb: number; heapUsedMb: number; externalMb: number } {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / 1024 / 1024),
    heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
    externalMb: Math.round(m.external / 1024 / 1024),
  };
}

export function emitStageEvent(e: StageEvent): void {
  console.log(JSON.stringify({
    event: 'stage_done',
    ts: new Date().toISOString(),
    ...e,
    ...memorySnapshot(),
  }));
}

export function emitCallEvent(e: CallEvent): void {
  console.log(JSON.stringify({
    event: 'call',
    ts: new Date().toISOString(),
    ...e,
  }));
}

/**
 * Classify a thrown error from a Gemini call into a stable `errorClass` so
 * we can group call events by failure mode in Cloud Logging. Mirrors the
 * patterns `isRetryableError` looks for in textVerify.ts — keep in sync if
 * the retry predicate changes. The patterns are ordered so the most
 * specific class wins (network errors before generic 5xx).
 */
export function classifyError(err: unknown): { statusCode?: number; errorClass: string } {
  if (err === null || err === undefined) return { errorClass: 'unknown' };
  const s = String(err);
  const m = s.match(/(?:status|code)[\s"':,=]*(\d{3})\b/i);
  const statusCode = m ? parseInt(m[1], 10) : undefined;

  if (/fetch failed|socket hang up/i.test(s)) return { errorClass: 'fetch_failed', statusCode };
  if (/\bECONNRESET\b/.test(s)) return { errorClass: 'econnreset', statusCode };
  if (/\bETIMEDOUT\b/.test(s)) return { errorClass: 'etimedout', statusCode };
  if (/\bEAI_AGAIN\b/.test(s)) return { errorClass: 'eai_again', statusCode };
  if (/\bUNAVAILABLE\b/.test(s)) return { errorClass: 'unavailable', statusCode: statusCode ?? 503 };
  if (/\bINTERNAL\b/.test(s)) return { errorClass: 'internal', statusCode: statusCode ?? 500 };
  if (/high demand/i.test(s)) return { errorClass: 'high_demand', statusCode };
  if (statusCode && statusCode >= 500) return { errorClass: '5xx', statusCode };
  if (statusCode && statusCode >= 400) return { errorClass: '4xx', statusCode };
  return { errorClass: 'other' };
}

/**
 * Thin async wrapper around the Gemini `generateContent` call. Times the
 * call, emits a `call_event` on both success and failure paths, and
 * re-throws the original error so existing retry / fallback logic is
 * unaffected. Wrap JUST the network call — bad-shape parse errors after
 * the response lands should not be classified as call failures.
 */
export async function instrumentedGenerateContent<T>(
  storyId: string,
  kind: CallKind,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    emitCallEvent({ storyId, kind, attempt, outcome: 'success', latencyMs: Date.now() - start });
    return result;
  } catch (err) {
    const { statusCode, errorClass } = classifyError(err);
    emitCallEvent({
      storyId, kind, attempt, outcome: 'failure',
      latencyMs: Date.now() - start, statusCode, errorClass,
    });
    throw err;
  }
}

export function storyTag(storyId: string): string {
  return `[story:${storyId}]`;
}
