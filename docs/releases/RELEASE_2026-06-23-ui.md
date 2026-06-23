# Release Notes — 2026-06-23 (Mobile UI thread)

## Summary

Shipped the **mobile UI / story-reader thread**: FC-026 (responsive layout) reached TestFlight as **iOS build 11**, and FC-035 (reader gesture rework — formerly FC-029) merged to `main` with its EAS build deliberately **held**. FC-026 fixes the Library "zooming into two giant cards" in landscape and the reader clipping baked-in narration text off the page across the Apple device matrix; FC-035 decouples tapping from page navigation (so tapping the info bars no longer flips the page) and adds a backward page-curl swipe.

> **Scope note:** this is the **mobile-UI thread**. It ran in parallel with two other threads that have their own notes: the FC-022/FC-023 reader fixes ([RELEASE_2026-06-22.md](RELEASE_2026-06-22.md), build #10) and the FC-017 reliability + social-sign-in track ([RELEASE_2026-06-23.md](RELEASE_2026-06-23.md)). Because of the parallel work, the shared checkout was frequently on another branch — all work here was done in isolated `git worktree`s.

## Changes

### New Features
- **Responsive Library grid (FC-026).** The library now computes its column count from available width (target ~178dp, clamped 2–5) via a new `useResponsive()` hook + pure `computeGrid()` helper, instead of a hard-coded `numColumns={2}`. iPhone Pro Max landscape now shows ~4 columns; iPad up to 5. (`mobile/hooks/useResponsive.ts`, `mobile/app/(tabs)/index.tsx`.)
- **Blurred ambient backdrop in the reader (FC-026).** Story pages are drawn `fit="contain"` (never cropping baked-in text); the resulting letterbox margins are filled by a single blurred, darkened cover-fit copy of the page so the reader reads full-bleed instead of black-barred.
- **Backward page-curl (FC-035).** The page-curl was forward-only; a left-to-right drag now curls the **previous** page back on (commit → `currentPage − 1`), reusing the existing GLSL shader unchanged. Forward swipe is unchanged.
- **Root `SafeAreaProvider` (FC-026)** so `useSafeAreaInsets()` is authoritative on rotation.

### Bug Fixes
- **Library unusable in landscape (FC-026).** Root cause: `numColumns={2}` with `flex:1` `aspectRatio:3/4` cells — doubling the row width in landscape doubled each card's size, so only the first row fit ("zoomed in"). Fixed by the reactive grid above (FlatList remounts on column change via `key`; `columnWrapperStyle` gap; fixed `cellWidth`; horizontal safe-area gutters).
- **Reader clipped baked-in narration text (FC-026).** Root cause: images drew `fit="cover"`, cropping edges, while landscape device aspect ratios span ~1.33:1 (iPad) to ~2.16:1 (Pro Max) with no pinned backend image ratio. `fit="contain"` guarantees no clipping on every device **and** repairs every already-generated story (baked images are frozen — a backend ratio change can't fix them).
- **Tap accidentally flipped the page (FC-035).** Root cause: tap was zoned (left 25% = prev, right 25% = next, center 50% = toggle), so a tap meant to reveal the info bars often landed in an edge zone and navigated. Fixed by decoupling: a tap **anywhere** now only toggles the controls; page turns are the curl swipe (forward + backward) and the dots row. (`Curl.tsx`, `read.tsx`; `TapZone` removed.)
- **Backward-cancel margin bleed (FC-035, caught in review).** The backward-cancel path initially never reset `isBackward`, so after any non-committed backward drag (incl. every page-0 rubber-band) the next page bled through the current page's `contain` letterbox margins at rest, persistently. Fixed by resetting `isBackward` on cancel + commit and tightening the backward reveal gate to `0 < pointer < width`.

### Performance & Optimization
- **Ambient backdrop kept out of the per-pixel curl shader (FC-026).** An earlier cut put the Gaussian blur inside the `PixelRatio`-scaled RuntimeShader layer, which (a) distorted the blur radius (~3× mismatch current vs next page) and (b) re-blurred at device resolution every animation frame. Reworked to a single backdrop drawn once behind the curl; only the sharp `contain` image lives in the shader layer.
- **Gestures memoized (FC-035).** `pan`/`tap`/`composed` are `useMemo`'d (deps exclude `direction`) so the mid-swipe `setDirection` re-render that swaps the rendered images can't recreate the gesture objects and drop the in-flight pan.

### Infrastructure
- **iOS build 11** (commit `1fa47c2` base, `autoIncrement` 10→11, EAS build `3b6b8535`) shipped **FC-026**; auto-submitted to App Store Connect / TestFlight via the ASC API key cached on EAS. buildNumber 11 recorded on `main` (PR #30, `44ac696`).
- **No OTA path** (unchanged fact): merging to `main` does not deploy; a new EAS build is required to reach TestFlight.

### Code Quality
- New reusable `useResponsive()` hook with a pure, unit-testable `computeGrid()` (ready for a test the moment FC-024 lands a mobile runner).

## Key Decisions & Rationale

- **Reader fit: `contain` + blurred backdrop, not `cover` + a backend "text-safe-margin" prompt.** `contain` is the only option that repairs **existing** stories (baked text is frozen in the PNG) and is deterministic; the safe-margin approach can't fix existing content and bets every future generation keeps text off the edges at ~90% layout reliability — reintroducing the exact bug.
- **Backward curl reuses the forward shader (no mirror variant).** Traced the GLSL: feeding the curl layer the previous image with `origin = width` and `pointer` animated `0 → width` makes the fold sweep left→right so the previous page enters from the left. Reusing one shader avoids a second shader to maintain.
- **Page navigation moved entirely to swipe + dots (FC-035), removing tap-to-turn.** The user chose full decoupling over keeping tap-to-turn (gated on controls visibility) or adding chevron buttons — and chose the backward *swipe* over dots-only or chevrons for backward nav, wanting the natural gesture.
- **Phasing FC-026.** Only the two reported bugs + the minimal responsive foundation shipped; broader iPad polish (FC-027) and an optional backend aspect-ratio pin (FC-028) were deferred as separate FCs.

## Discoveries

- **`usePageImages` already exposed `prev`** (`{ prev, current, next }`, correctly gated for page 0 and FC-022 synthetic pages) — the backward curl needed no hook change, just wiring `pageImages.prev` into `Curl`.
- **Landscape device aspect ratios span ~1.33:1 (iPad) → ~2.16:1 (Pro Max).** No single baked-image ratio matches all of them, which is why `contain` (not any pinned ratio) is the durable reader fix.
- **`computeGrid` column counts** (target 178dp, gap 14, clamp 2–5): iPhone SE/15/Pro Max portrait → 2; phone landscape → 3; Pro Max landscape → 4; iPad portrait → 4; iPad Pro landscape → 5 (capped). Cells land 161–249dp.

## Known Issues

- **FC-035 has not been verified on a device** (no simulator/device available in-session). It's gesture + shader work with a couple of documented 1-frame edge artifacts at swipe start/reset — needs a real-device pass. Severity: medium (core reading interaction).
- **FC-026 on-device verification** was completed by the user on build 11 (gradient bars confirmed good); the backward curl in FC-035 still awaits the next build.

## Next Steps

1. **One combined EAS build (→ build 12)** when the user gives the go-ahead — `main` now carries FC-026, FC-035, the FC-017 reliability track, and the social-sign-in work; a single production build + App Store submission ships them together. Verify on TestFlight: forward/backward curl, taps no longer flip pages, plus the login flow and the 202-ACK generating screen.
2. **FC-027** — iPad/landscape polish across login/register/settings/create (form max-widths, the create-wizard's phone-tuned `31%`/`70%` widths).
3. **FC-028** (optional) — pin the backend image aspect ratio (~16:9) to shrink letterbox bands on new stories.
4. **FC-024** — stand up a mobile test runner; first target the pure `computeGrid` helper.

## Files Changed

- FC-026 (PR #28, `1fa47c2`): 6 files, +349/−36 — `useResponsive.ts` (new), `index.tsx`, `_layout.tsx`, `Curl.tsx`, plus FC docs.
- buildNumber 11 (PR #30, `44ac696`): 1 file, +1/−1 (`app.json`).
- FC-035 (PR #33, `8336571`): 4 files, +222/−73 — `Curl.tsx`, `read.tsx`, plus FC docs (renumbered to `fc-035.md`).

## Configuration Changes Required

- None. (FC-026's `autoIncrement`/`appVersionSource: local` and the ASC API key on EAS were already configured; build 11 used them non-interactively.)
