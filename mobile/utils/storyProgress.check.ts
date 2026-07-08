/**
 * FC-036 — executable proof for the pure progress model
 * (mobile/utils/storyProgress.ts).
 *
 * WHY THIS IS A PLAIN-TS SCRIPT, NOT A .test.ts:
 * The mobile package has no test runner on this branch — FC-024 owns
 * jest-expo + @types/jest + CI, and it has not merged yet. A jest-style
 * `.test.ts` (describe/it/expect) does not typecheck under `npx tsc --noEmit`
 * without those types on the branch (TS2304 'Cannot find name expect'), which
 * would break the FC-036 Definition-of-done. So the Verification table is
 * encoded here as plain TypeScript that tsc typechecks cleanly and runs via
 * `npx tsx utils/storyProgress.check.ts`.
 *
 * DEFERRED: once FC-024 lands jest-expo + @types/jest on main, this converts
 * back to a durable `mobile/utils/__tests__/storyProgress.test.ts`. Until then
 * this script is the executable proof (its passing output is quoted in the PR).
 *
 * Coverage = the plan's 9-row Verification table (docs/plans/fc-036.md
 * §Verification) + the reviewer-driven additions (label-honesty gating,
 * malformed-label reconciliation, and the perceptible-motion floor).
 */
import {
  computeStoryProgress,
  clampMonotonic,
  applyCreepFloor,
  getExpectedPages,
  BANDS,
  MALFORMED_FLOOR,
  MIN_TICK_DELTA,
  EXPECTED_PAGES,
  type ProgressDocInput,
} from './storyProgress';

let checks = 0;
let failures = 0;

/** Throw on mismatch; log pass. Deep-equal via JSON for arrays/objects. */
function check(name: string, got: unknown, want: unknown): void {
  checks += 1;
  const eq =
    got === want ||
    (typeof got === 'number' &&
      typeof want === 'number' &&
      Number.isFinite(got) &&
      Number.isFinite(want) &&
      Math.abs(got - want) < 1e-9) ||
    JSON.stringify(got) === JSON.stringify(want);
  if (!eq) {
    failures += 1;
    console.error(`  FAIL: ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
    return;
  }
  console.log(`  pass: ${name}`);
}

/** Assert a boolean predicate directly. */
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

const doc = (over: Partial<ProgressDocInput>): ProgressDocInput => ({ ...over });

// ── Row 1: Malformed doc → {fraction: 0.05, label: 'Starting…'} ──────────────
{
  const missing = computeStoryProgress(doc({ status: 'generating' }), 6, 0);
  check('malformed(missing progress) fraction', missing.fraction, MALFORMED_FLOOR);
  check('malformed(missing progress) label', missing.label, 'Starting…');

  // Unknown phase string is treated the same; a stray backend message must NOT
  // leak (reviewer R2-3 reconciliation).
  const unknown = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'bananas', message: 'internal-string' } }),
    6,
    0,
  );
  check('malformed(unknown phase) fraction', unknown.fraction, MALFORMED_FLOOR);
  check('malformed(unknown phase) label no-leak', unknown.label, 'Starting…');
}

// ── Row 2: Queued floor → 0 ≤ fraction < 0.05 at elapsed 0 ───────────────────
{
  const r0 = computeStoryProgress(doc({ status: 'queued', progress: { phase: 'queued' } }), 6, 0);
  check('queued at elapsed 0 → fraction 0', r0.fraction, 0);
  const rLater = computeStoryProgress(doc({ status: 'queued', progress: { phase: 'queued' } }), 6, 5_000);
  checkTrue('queued later → fraction > 0', rLater.fraction > 0);
  checkTrue('queued later → fraction < queuedEnd', rLater.fraction < BANDS.queuedEnd);
}

// ── Row 3: Char-ref ticks → base 0.15 + 0.40×(2/4) = 0.35; creep < next ──────
{
  const input = doc({
    status: 'generating',
    progress: { phase: 'char-refs', completedSteps: 2, totalSteps: 4 },
  });
  const atZero = computeStoryProgress(input, 6, 0);
  check('char-refs 2/4 base fraction 0.35', atZero.fraction, 0.35);
  const nextBoundary = 0.15 + 0.4 * (3 / 4); // 0.45
  check('char-refs 2/4 nextBoundary 0.45', atZero.nextBoundary, nextBoundary);
  const crept = computeStoryProgress(input, 6, 1_000_000);
  checkTrue('char-refs crept > base', crept.fraction > 0.35);
  checkTrue('char-refs crept < nextBoundary', crept.fraction < nextBoundary);
}

// ── Row 4: Asymptote never crosses the next boundary for any realistic elapsed ─
// NOTE: at large-enough elapsed `Math.exp(-t/τ)` underflows to exactly 0.0 and the
// creep floating-point-equals the boundary — so an "eternity" elapsed does NOT
// prove strict inequality (it proves FP underflow). The plan's guarantee is
// "strictly < next boundary for all realistic *finite* elapsed". Use 60_000ms
// (1 min) — well past any real per-tick gap (the largest τ is char-refs 90s but
// ticks land per-ref long before then; the smallest τ is finalizing 10s, giving
// t/τ=6, exp(-6)≈0.0025 > 0). At this elapsed every band's creep is meaningfully
// advanced yet still strictly below its boundary, which is the property under test.
{
  const cases: ProgressDocInput[] = [
    doc({ status: 'generating', progress: { phase: 'queued' } }),
    doc({ status: 'generating', progress: { phase: 'story-text', completedSteps: 0, totalSteps: 1 } }),
    doc({ status: 'generating', progress: { phase: 'char-refs', completedSteps: 1, totalSteps: 3 } }),
    doc({ status: 'generating', castAttempted: true, progress: { phase: 'char-refs' } }),
    doc({ status: 'generating', progress: { phase: 'parallel-pages' }, pageUrlsCount: 2 }),
    doc({ status: 'generating', progress: { phase: 'finalizing' } }),
  ];
  const REALISTIC_MAX_ELAPSED = 60_000; // 1 minute — past any tick gap, no FP underflow
  cases.forEach((c, i) => {
    const r = computeStoryProgress(c, 6, REALISTIC_MAX_ELAPSED);
    checkTrue(`asymptote case ${i} fraction < nextBoundary`, r.fraction < r.nextBoundary);
  });
}

// ── Row 5: Cast/title flags → cast-only ≥0.55 & <0.70; both cross 0.70 only w/ pages
{
  const castOnly = computeStoryProgress(
    doc({ status: 'generating', castAttempted: true, progress: { phase: 'char-refs' } }),
    6,
    0,
  );
  checkTrue('cast-only fraction ≥ castEnd', castOnly.fraction >= BANDS.castEnd);
  checkTrue('cast-only fraction < titleEnd', castOnly.fraction < BANDS.titleEnd);
  check('cast-only label = cover', castOnly.label, 'Painting the cover…');

  // Both flags, no page yet: base is exactly 0.70 (page 0 of N).
  const both = computeStoryProgress(
    doc({
      status: 'generating',
      castAttempted: true,
      titleAttempted: true,
      pageUrlsCount: 0,
      progress: { phase: 'char-refs' },
    }),
    6,
    0,
  );
  check('both flags base = titleEnd (0.70)', both.fraction, BANDS.titleEnd);
  // Reviewer R1-1: caption must NOT claim page-painting before a page phase.
  check('both flags label = cover (not page 1)', both.label, 'Painting the cover…');
}

// ── Row 6: Page increments → 0.70 + 0.28×(3/6) = 0.84 ────────────────────────
{
  const r = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'parallel-pages' }, pageUrlsCount: 3 }),
    6,
    0,
  );
  check('pages 3/6 base fraction 0.84', r.fraction, 0.84);
  check('pages 3/6 label', r.label, 'Painting page 4 of 6…'); // painting the 4th while 3 done
}

// ── Row 7: Finalize / complete → 0.98 creeping <1.0 / exactly 1.0 ────────────
{
  const fin0 = computeStoryProgress(doc({ status: 'generating', progress: { phase: 'finalizing' } }), 6, 0);
  check('finalizing base = pagesEnd (0.98)', fin0.fraction, BANDS.pagesEnd);
  // 20s elapsed (2×τ_finalizing) — creep is visible yet still strictly below 1.0.
  // (At 1_000_000ms exp(-100) underflows to 0.0 and it FP-equals 1.0; the plan's
  // guarantee is strict inequality for realistic finite elapsed, not eternity.)
  const finLater = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'finalizing' } }),
    6,
    20_000,
  );
  checkTrue('finalizing later > 0.98', finLater.fraction > BANDS.pagesEnd);
  checkTrue('finalizing later < 1.0', finLater.fraction < 1);

  const complete = computeStoryProgress(doc({ status: 'complete' }), 6, 0);
  check('complete fraction exactly 1.0', complete.fraction, 1);
  check('complete label', complete.label, 'All done!');
}

// ── Row 8: Monotonicity — out-of-order regressions never decrease ────────────
{
  const raw = [0.05, 0.35, 0.34 /* regression */, 0.5, 0.49 /* regression */, 0.84];
  let prev: number | null = null;
  const displayed = raw.map((f) => {
    prev = clampMonotonic(prev, f);
    return prev;
  });
  check('clampMonotonic sequence', displayed, [0.05, 0.35, 0.35, 0.5, 0.5, 0.84]);
  let nonDecreasing = true;
  for (let i = 1; i < displayed.length; i++) {
    if (displayed[i] < displayed[i - 1]) nonDecreasing = false;
  }
  checkTrue('clampMonotonic never decreases', nonDecreasing);
}

// ── Row 9: Resume hold — 0.84, then attempt+1 with early-phase doc → stays 0.84
{
  const beforeResume = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'parallel-pages' }, pageUrlsCount: 3, attempt: 1 }),
    6,
    0,
  );
  check('resume before fraction 0.84', beforeResume.fraction, 0.84);

  const afterResume = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'story-text', completedSteps: 0, totalSteps: 1 }, attempt: 2 }),
    6,
    0,
  );
  checkTrue('resume raw fraction legitimately drops', afterResume.fraction < 0.84);
  const held = clampMonotonic(beforeResume.fraction, afterResume.fraction);
  check('resume clamp holds max 0.84', held, 0.84);
  checkTrue('resume milestoneKey changes (timer resets)', afterResume.milestoneKey !== beforeResume.milestoneKey);
}

// ── Label honesty (reviewer R1-1 / R2-3) ─────────────────────────────────────
{
  // Resume re-entering char-refs with preserved pageUrls → a page really landed,
  // so the page caption IS allowed here.
  const r = computeStoryProgress(
    doc({
      status: 'generating',
      progress: { phase: 'char-refs', completedSteps: 1, totalSteps: 3 },
      pageUrlsCount: 2,
      attempt: 2,
    }),
    6,
    0,
  );
  checkTrue('resume+pages fraction ≥ titleEnd', r.fraction >= BANDS.titleEnd);
  check('resume+pages label allowed (real page landed)', r.label, 'Painting page 3 of 6…');

  // childName used when present; neutral copy when blank.
  const withName = computeStoryProgress(
    doc({ status: 'generating', childName: 'Mira', progress: { phase: 'story-text', completedSteps: 0, totalSteps: 1 } }),
    6,
    0,
  );
  checkTrue('childName present is used', withName.label.includes('Mira'));
  const noName = computeStoryProgress(
    doc({ status: 'generating', childName: '  ', progress: { phase: 'story-text', completedSteps: 0, totalSteps: 1 } }),
    6,
    0,
  );
  check('blank childName → neutral copy', noName.label, 'Dreaming up the story…');

  // Page caption never shows N > M or page 0 even with over-count.
  const over = computeStoryProgress(
    doc({ status: 'generating', progress: { phase: 'parallel-pages' }, pageUrlsCount: 9 }),
    6,
    0,
  );
  check('page over-count label capped', over.label, 'Painting page 6 of 6…');
  check('page over-count fraction capped at pagesEnd', over.fraction, BANDS.pagesEnd);
}

// ── applyCreepFloor (reviewer R2-2 perceptible motion) ───────────────────────
{
  const next = applyCreepFloor(0.3, 0.3, 0.55);
  checkTrue('creepFloor advances ≥ MIN_TICK_DELTA', next >= 0.3 + MIN_TICK_DELTA - 1e-9);
  checkTrue('creepFloor stays < boundary', next < 0.55);

  // At the very edge there is no headroom → hold, still strictly below boundary.
  const atCeiling = applyCreepFloor(0.5499, 0.5499, 0.55);
  checkTrue('creepFloor at ceiling < boundary', atCeiling < 0.55);
  checkTrue('creepFloor at ceiling never regresses', atCeiling >= 0.5499);

  // A real milestone landed (computed jumps past prev): the floor takes the
  // honest computed value as its base and still adds one MIN_TICK_DELTA of
  // perceptible motion (bounded below the boundary). So base 0.5 → 0.5015, NOT
  // a flat 0.5. This is the intended R2-2 behavior — every tick advances.
  const jumped = applyCreepFloor(0.3, 0.5, 0.55);
  check('creepFloor honest jump uses computed as base', jumped, 0.5 + MIN_TICK_DELTA);
  checkTrue('creepFloor honest jump still < boundary', jumped < 0.55);
  checkTrue('creepFloor honest jump never below computed', jumped >= 0.5);

  // Already at/over ceiling → hold.
  check('creepFloor holds at ceiling', applyCreepFloor(0.55, 0.55, 0.55), 0.55);
}

// ── getExpectedPages mirror of backend getPageCount ──────────────────────────
{
  check('expected short', getExpectedPages('short'), EXPECTED_PAGES.short);
  check('expected medium', getExpectedPages('medium'), EXPECTED_PAGES.medium);
  check('expected long', getExpectedPages('long'), EXPECTED_PAGES.long);
  check('expected undefined → 6', getExpectedPages(undefined), 6);
  check('expected gibberish → 6', getExpectedPages('gibberish'), 6);
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`\nALL ${checks} CHECKS PASSED`);
