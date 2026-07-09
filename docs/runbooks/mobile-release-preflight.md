# Runbook: Mobile release preflight — on-device smoke test before TestFlight submit

**This is a mandatory gate, not a suggestion.** Run it before promoting **any** EAS iOS
production build to external testers / the App Store.

## Symptom (why this gate exists)

TestFlight **build 14** shipped a crash: the story reader crashed on the **first page
turn** (FC-044). The cause was a release-only failure mode — FC-040's tap handler called a
non-worklet function inside a UI-thread gesture worklet, which is **fatal in a release/Hermes
build but invisible in dev** (dev client + Expo Go run it fine). It passed **two** code-level
adversarial reviews and `tsc`. Nothing in the automated path could have caught it:

- There is **no mobile test runner** for runtime/component behavior (FC-024 is still open —
  the backend has Vitest; `mobile/` has only jest unit tests for pure helpers).
- The bug class does not reproduce in the dev client, so "it worked when I ran it locally"
  is not evidence.

**The only thing that catches this class is a human turning pages on a real release build.**
So that is now a required step before every production submit.

## When to run

Before `eas submit -p ios --profile production` promotes a build to testers — i.e. after the
EAS **production** build finishes and before (or immediately after) submitting, verified on the
actual TestFlight build **on a physical device**. Do NOT rely on the dev client for this.

## The gate (~2–3 minutes on a physical device)

Install the build from TestFlight (not `expo start` / dev client), then:

1. **Launch + auth** — app opens, sign in (or already-signed-in cold start restores session).
2. **Reader page turns (the FC-044 crash point — do this first):** open an existing story →
   **tap the right edge to turn forward**, several pages → **tap the left edge to turn
   backward** → **tap the center to toggle the control bars** → **tap ✕ to exit**. No crash,
   no wrong-page flash, ✕ reachable, a page-turn does not also toggle bars (and vice versa).
3. **Generate a story end-to-end** — create flow → watch the progress screen advance through
   phases (no stall, no crash) → story opens and is readable. (Also confirms the live safety
   backend — FC-037/FC-041 — didn't break generation.)
4. **Input safety** — enter a deliberately-unsafe `favoriteAnimal` → friendly rejection, not a
   crash or a bad story.
5. **Form factors** — repeat the reader check on an iPad (both orientations) if iPad is a target.

## Resolution

- **All steps pass** → safe to promote the build to testers.
- **Any crash / hang / obviously-wrong behavior** → **do NOT promote.** Capture the device +
  OS, reproduce, file the fix (single-file crash fixes are plan-exempt), cut a **new** EAS
  production build, and re-run this gate. Never ship the failing build "to get feedback."

## Validation

The build a tester installs must be the one that passed this gate. Confirm the submitted
build's number/commit matches what you smoke-tested (`eas build:list` → build number; the
`app.json` `buildNumber` commit records it).

## Automate this away (the real fix)

This manual gate is a stopgap for the missing runner. The durable fix is **FC-024** (mobile
test runner + CI) extended with an **on-device e2e smoke** (Maestro or Detox) that scripts
steps 2–3 against a release build in CI, so "open a story, turn a page" is enforced
mechanically before submit rather than by memory.

## Last verified

_Not yet run end-to-end as a formal gate — established 2026-07-09 after the FC-044 incident.
Update this date the first time it's run through on a real device._
