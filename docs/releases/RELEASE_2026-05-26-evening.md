# Release Notes — 2026-05-26 (evening session)

## Summary

Root-caused and fixed the two-week-old iPhone TestFlight launch crash that had blocked physical-device testing since 2026-05-12. A single-file fix in `mobile/services/firebase.ts` resolved it; EAS build #8 shipped to TestFlight and installed cleanly on the user's iPhone 16e (iOS 26.x), confirming launch works. The diagnostic path matters more than the diff: the 5/12 device-crash signature (Hermes / TurboModule / dyld cascade) was a downstream symptom of an unhandled JS exception during early imports, and the cell of the 2x2 we'd never tested (Release config on simulator) surfaced the clean cause in one run.

## Changes

### New Features
- None this session.

### Bug Fixes
- **(BLOCKER, fixed) `mobile/services/firebase.ts` used dynamic `process.env[name]` access in a loop, which Metro/Babel cannot statically analyze.** Result: `EXPO_PUBLIC_FIREBASE_*` env vars were never inlined into the Release JS bundle. At cold-launch every Firebase var came back `undefined`, throwing `"Missing: EXPO_PUBLIC_FIREBASE_API_KEY, EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN, ..."`. On a physical device with new arch + bridgeless (Release path only), the unhandled exception during early import evaluation propagated through TurboModule → `convertNSExceptionToJSError` → `backtrace_symbols` → dyld → BAD_ACCESS. This is exactly the opaque Hermes crash signature we chased through three busted hypotheses on 5/12 (lockfile drift, unused autolinked native modules, precompiled modules). The actual JS exception was swallowed by the dyld crash on Thread 2 before the error could be flushed to any device-side log. **Fix:** switched to literal static `process.env.EXPO_PUBLIC_FIREBASE_*` accesses inside a single object literal so Metro can inline at bundle time. Validation logic (missing + placeholder detection, error message) is byte-for-byte preserved. `api.ts`'s `process.env.EXPO_PUBLIC_API_URL` was already static and was inlining fine — the dynamic-vs-static delta in one file was the entire bug.

### Performance & Optimization
- None this session.

### Infrastructure
- **EAS production iOS build #8 shipped.** Auto-incremented `buildNumber` 7 → 8 (committed). Build URL: https://expo.dev/accounts/memon1987/projects/ai-storybook/builds/c67b6682-fde9-4398-9833-040f4e848b7a. Auto-submitted to TestFlight; processing confirmation arrived via email; install on iPhone 16e succeeded; app launches cleanly into login screen. Closes the 5/12 BLOCKER from `RELEASE_2026-05-12.md`.

### Code Quality
- No new tests added — single-file fix exempt per project workflow (single-file bug fix, +16 / -14, no behavior change beyond the fix itself). The behavior assertion is "Firebase initializes" which is implicitly covered by any successful auth call; no useful unit-test framing exists for "Metro's transform inlined this constant."

## Key Decisions & Rationale

- **Reproduced the crash on `expo run:ios --configuration Release` on the iPhone 16e *simulator* first, NOT on the physical device.** Three prior hypotheses on 5/12 were chased by triaging the device crash logs alone, which sent us into native-layer / dep / toolchain dead ends. The Debug-on-Sim path that we tested in every prior session always worked, masking the bug. The 2x2 (Debug/Release × Sim/Device) had a critical untested cell — Release on Sim — which surfaced the clean JS exception in one run. The decision matrix going forward: if a crash is device-only with an opaque Hermes/TurboModule cascade, **first** repro on Sim with Release config before going deep on native theories.
- **Fixed by changing the access pattern, not by adding fallbacks.** Other options considered: (a) catch the throw and fall back to defaults — rejected, would silently hide misconfiguration in development; (b) add a build-time generated `env.ts` from `.env` — rejected, over-engineering for a problem the standard pattern already solves; (c) move to `expo-constants` `Constants.expoConfig.extra` — rejected, requires app config change + more refactor surface, and adds an unnecessary abstraction. The minimal fix preserves the same validation behavior and same error message; only the access pattern changed.
- **Picked EAS + TestFlight over local USB install** when asked. Slower feedback loop (~15 min vs ~5 min) but matches the exact failing path from 5/12 — local USB on a fresh signing identity could have worked while TestFlight still failed, so the more conclusive test was warranted given two weeks of stalled progress. Trade-off accepted.
- **Branch + PR despite the change being plan-exempt.** Project CLAUDE.md exempts single-file bug fixes <50 lines from plan files but still requires branch + PR for any change to production code paths. Followed that rule. PR #22 squash-merged to main as `d476cf9`.
- **Did NOT amend the EAS-auto-bumped `app.json` `buildNumber` into the fix commit.** Kept it as a separate `chore(mobile): bump buildNumber to 8` commit so the fix commit's diff stays a true representation of the behavioral change. Squash-merge collapsed both into one main-line commit, which is fine for history.
- **Skipped peer-review agent for this fix.** Project CLAUDE.md mandates peer review for plan-driven (M/L) work; this was a plan-exempt single-file bug fix where the diagnostic itself (env var present in bundle: yes/no via grep) is the verification. Adversarial review wouldn't change confidence here — the fix either inlines or doesn't, and we measured it.

## Discoveries

- **Babel/Metro static-env inlining is fragile in a specific way.** Only literal `process.env.KEY` (static member expression) gets substituted. Dynamic access patterns — `process.env[name]`, destructure, spread, `Object.keys(process.env)` — silently no-op and return `undefined` at runtime in production. No warning is emitted by the transform. This is true for any similar build-time env-inlining (EXPO_PUBLIC_*, NEXT_PUBLIC_*, Vite import.meta.env-style transforms in some configs). Worth memorizing: in any JS codebase that depends on build-time env substitution, dynamic env access is a latent production-only bug.
- **The symptom-vs-cause inversion on the device is brutal.** Unhandled JS exceptions during early synchronous imports, on new arch + bridgeless mode, present on the device as Hermes crashing in *unrelated* code (`String.prototype.match` dereferencing a UTF-16 path-string from a totally different stack) because RN's error-conversion path (`convertNSExceptionToJSError` → `backtrace_symbols` → dyld) corrupts memory before the actual JS error string can be flushed. On simulator Debug, the error handling catches it cleanly and just logs. The device crash log gives zero indication that the actual cause is a string literal somewhere else in `import`-evaluation order. This is the kind of bug class where the symptom is loud and uninformative and the cause is quiet and exact.
- **The smoking-gun diagnostic is `grep -c <known-env-value> main.jsbundle`.** Before fix: 0 (var not inlined). After fix: 1 (var inlined). This is faster and more conclusive than reading transformed source, decompiling Hermes bytecode, or attaching a debugger. Capture as a standard diagnostic for "is this env var actually in the production bundle?"
- **`api.ts` and `firebase.ts` in the same project were a controlled-experiment pair without anyone planning it.** Same file pattern (top-of-file `process.env.*` reads), same env-var prefix, same bundle. `api.ts` (static literal) inlined fine; `firebase.ts` (dynamic loop) didn't. This pair was the single most convincing piece of evidence — same project, same bundler, only the access pattern differs.

## Data Baselines

- **EAS iOS build wall-clock (build #8):** ~9 min from `eas build` invocation to TestFlight upload complete. Apple processing added another ~5-10 min before TestFlight made it installable. Consistent with the warm-cache range from `RELEASE_2026-05-12.md` (~5-6 min cold-build at the time, but with full toolchain churn since).
- **Diff scope:** 1 file, +16 / -14 lines in `firebase.ts`; 1 line in `app.json` for buildNumber. Tightest possible fix for a 2-week blocker.
- **Bundle inlining verification:** `AIzaSyBEOhJTwkJ1R5zjKc73ekUGs55a4Sog_98` (Firebase API key) appears 0× in `main.jsbundle` pre-fix, 1× post-fix.
- **Crash hypothesis dead-end cost (cumulative from 5/12 + tonight):** 4 hypotheses tested, 3 dead ends before the right one. Each dead end on 5/12 cost ~1 EAS build (~15 min) + investigation time. The fourth hypothesis (Debug-vs-Release config difference) was the one that finally led to the actual cause, just via a different (cheaper) path — local Release-on-Sim repro instead of bisecting cold-launch imports.

## Known Issues

- **(LOW, deferred) Pre-FC-020 stories in the user's library render with a blank gap** where the Skia overlay used to live (per `RELEASE_2026-05-26.md` known issues). User started generating a fresh story at session end to test the FC-020 baked-text flow on real device — result of that flow is the first thing to check next session.
- **(LOW, deferred) OCR-verify the title/cover page** — currently skipped, low jumble risk.
- **(LOW, deferred) Wrap `uploadGeneratedImage` in try/catch** → placeholder fallback.
- **(MEDIUM, pre-existing) 600s mobile axios timeout vs char-ref tail latency.** A 12-page story or a single bad char-ref roll could breach the client timeout; backend silently finishes and saves the story but user sees an error. Acceptable for prototype; the durable fix is FC-017 (deferred per 5/26 morning direction until prototype is working).
- **(MEDIUM, pre-existing) Cloud Run instance can die mid-request and lose ~80% of work** (per the 5/12 incident → FC-017). Unchanged.

## Next Steps

User direction at session end: **call it a night, pick up later.** A fresh story was generating on the iPhone when we stopped. Suggested priorities for next session, in order:

1. **Check the in-flight test story result on the iPhone** — did the FC-020 baked-text flow render cleanly end-to-end on real device? If yes, FC-020 is validated on the prototype. If anything looks off (jumbled text, missing pages, layout issues, perf), capture screenshots + the story ID and we'll work it from there.
2. **Regenerate any other test stories** so the prototype demo library shows post-FC-020 content (pre-FC-020 stories have the blank-gap issue).
3. **End-to-end prototype validation** — login flow, create flow, library, reader gestures (page curl, swipe), settings. First time exercising the FC-020 build on real hardware.
4. **Optional LOWs:** OCR-verify title page (~30 lines), wrap `uploadGeneratedImage` in try/catch (~10 lines). Each is a single-file bug-fix-equivalent; cheap if user wants them.
5. **Then FC-017** (async / resume / progress UI). Investigation step (Cloud Run instance metrics + memory profile during a story generation) must precede the plan per its FUTURE_CONSIDERATIONS entry.
6. **FC-016 latency reduction** (re-scoped around char refs per the 5/22 finding) is the natural follow-on if char-ref latency becomes the user-visible bottleneck once the async/resume infra exists.

## Files Changed

- 2 files changed, +17 / -15 lines across 1 PR (#22, squash-merged as `d476cf9`):
  - `mobile/services/firebase.ts`: +16 / -14 — the dynamic→static `process.env` access fix.
  - `mobile/app.json`: +1 / -1 — `buildNumber` 7 → 8 (EAS auto-increment).
- Plus this release notes file (`docs/releases/RELEASE_2026-05-26-evening.md`), documentation-only.

## Configuration Changes Required

- None. `mobile/.env` (local) and `mobile/eas.json` (cloud builds) already had the correct `EXPO_PUBLIC_FIREBASE_*` values. The bug was purely in how `firebase.ts` read them at runtime, not in what was provided.
