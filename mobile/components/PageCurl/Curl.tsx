import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, PixelRatio, StyleSheet } from 'react-native';
import {
  Canvas,
  Image as SkiaImage,
  Group,
  Paint,
  Blur,
  RuntimeShader,
  Skia,
  Rect,
  type SkImage,
  type SkRect,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useSharedValue,
  useDerivedValue,
  useAnimatedReaction,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { pageCurl } from './pageCurl';
import { resolveTapZone } from './tapZones';

type Direction = 'forward' | 'backward';

interface CurlProps {
  width: number;
  height: number;
  currentImage: SkImage | null;
  nextImage: SkImage | null;
  previousImage: SkImage | null;
  currentPage: number;
  totalPages: number;
  onPageChange: (newPage: number) => void;
  // FC-035/FC-040: tap in the center zone toggles the reader controls only.
  // Edge-zone taps drive page turns (handled internally); this callback never
  // navigates.
  onTap: () => void;
  // FC-040 review fix (HIGH): the ✕ / dots are live RN Pressables that overlap
  // the horizontal turn zones. When the bars are visible we exclude their
  // vertical bands from the Curl's tap routing so a tap on the ✕ or a dot can
  // never also turn/toggle underneath it. When hidden, the full zones turn.
  controlsVisible?: boolean;
  topBandHeight?: number;
  bottomBandHeight?: number;
  // FC-040 review fix (MEDIUM): a JS-thread busy latch the parent can read to
  // drop dot-jumps while a turn is in flight (goToPage bypasses the internal
  // guard otherwise, desyncing currentPage from the animation). Curl sets this
  // synchronously on turn entry and clears it wherever the animation ends.
  busyRef?: React.MutableRefObject<boolean>;
}

const CORNER_RADIUS = 0;
// FC-040: one shared self-running curl duration for both directions. Slowed from
// 500ms → 750ms per user feedback (build 15 felt too fast for a bedtime reader).
const TURN_MS = 750;

// FC-026: every page is drawn fit="contain" so no baked-in narration text is
// ever cropped on any device/orientation. The resulting letterbox margins are
// filled by a single blurred, darkened ambient backdrop (a cover-fit copy of
// the current page) so the reader looks full-bleed instead of black-barred.
const BACKDROP_BLUR = 22;
const BACKDROP_DARKEN = 'rgba(0,0,0,0.35)';

interface AmbientBackdropProps {
  image: SkImage;
  rect: SkRect;
  width: number;
  height: number;
}

// Blurred, darkened cover-fit bed that fills the contain letterbox margins.
// Drawn ONCE behind the curl — deliberately kept OUT of the pd-scaled shader
// layer so (a) the blur radius isn't distorted by the scale transform and
// (b) the expensive blur isn't recomputed inside the per-pixel curl pass.
function AmbientBackdrop({ image, rect, width, height }: AmbientBackdropProps) {
  return (
    <Group>
      <Group layer={<Paint><Blur blur={BACKDROP_BLUR} /></Paint>}>
        <SkiaImage image={image} rect={rect} fit="cover" />
      </Group>
      <Rect x={0} y={0} width={width} height={height} color={BACKDROP_DARKEN} />
    </Group>
  );
}

// FC-020: pure page-curl of the illustrations. Narration text is baked into the
// images themselves, so there is no text overlay to render here anymore.
// FC-040: page turns are self-running, fire-and-forget curl animations triggered
// by edge taps — the curl is no longer tracked to a finger.
export function Curl({
  width,
  height,
  currentImage,
  nextImage,
  previousImage,
  currentPage,
  totalPages,
  onPageChange,
  onTap,
  controlsVisible = false,
  topBandHeight = 0,
  bottomBandHeight = 0,
  busyRef,
}: CurlProps) {
  const pd = PixelRatio.get();

  // FC-040 review fix (HIGH): JS-thread busy latch, set SYNCHRONOUSLY at the top
  // of turnForward/turnBackward. `isAnimating` is a shared value whose JS-thread
  // writes are async-batched (queueMicrotask), so a rapid double-tap can read a
  // stale `false` before the first write flushes and slip two turns through
  // (double-commit / flash). This ref is written and read synchronously on the
  // JS thread, so two sequential turn calls are strictly ordered. It is cleared
  // wherever `isAnimating` is cleared (useLayoutEffect reset + the !finished
  // cancel branch). We fall back to a local ref if the parent doesn't pass one.
  const localBusyRef = useRef(false);
  const busy = busyRef ?? localBusyRef;

  const origin = useSharedValue(width);
  const pointer = useSharedValue(width);
  // Worklet-readable mirror of `direction`. The shader math runs on the UI
  // thread and can't read React state, so we drive it from this shared value
  // and keep `direction` in sync to swap the rendered curl/reveal images. See
  // FC-035: forward peels the CURRENT page to reveal NEXT; backward un-peels the
  // PREVIOUS page over CURRENT.
  const isBackward = useSharedValue(false);
  // FC-040 entry guard: taps during an in-flight animation are ignored (no
  // queue, no mid-flight reversal). Reset by finishSettle / useLayoutEffect so
  // it can never wedge shut.
  const isAnimating = useSharedValue(false);
  const [direction, setDirection] = useState<Direction>('forward');

  // FC-040 settle gate — the flash-free commit. The documented flash is the
  // page-swap (JS thread) and the curl-value reset (UI thread) landing in
  // different frames: a frame can render the freshly-swapped images against
  // stale curl values, showing a fully-peeled new page or the next-next page.
  //
  // The gate makes the handoff atomic on BOTH ends:
  //   Entry (JS-thread atomic): the completion worklet leaves the last animated
  //     frame on screen (target page full-screen via the reveal layer) and calls
  //     `commit`, which in ONE React commit (a) freezes the target page into
  //     `settleImage`, (b) sets `settling=true` to hide the reveal+curl layers,
  //     and (c) advances `currentPage`. The frozen full-screen `settleImage`
  //     therefore appears in the exact same commit the new page images arrive —
  //     no wrong-page frame.
  //   Exit (UI-thread atomic): `useLayoutEffect` resets the curl shared values
  //     (pointer/origin=width) on the next render. `settleShared` stays true, so
  //     a `useAnimatedReaction` waits until the UI thread has actually applied
  //     pointer===width before clearing `settling`/`settleImage`. Only then do
  //     the reveal/curl layers un-hide — guaranteed against reset (not stale)
  //     curl values. The now-flat curl layer shows the SAME decoded SkImage the
  //     settle layer was showing (usePageImages reuses it) → pixel-identical.
  const [settling, setSettling] = useState(false);
  const [settleImage, setSettleImage] = useState<SkImage | null>(null);
  const settleShared = useSharedValue(false);
  // Armed by useLayoutEffect (post-commit) once the curl reset has been written.
  // The reaction only clears the settle gate after this is set, so a raw
  // pointer===width at BACKWARD completion (before the page has committed) can
  // never trigger an early clear.
  const settleClearReady = useSharedValue(false);
  // Refs so the completion worklet's runOnJS commit reads the values current at
  // completion time without re-creating the worklet each render.
  const nextImageRef = useRef(nextImage);
  nextImageRef.current = nextImage;
  const previousImageRef = useRef(previousImage);
  previousImageRef.current = previousImage;
  const currentImageRef = useRef(currentImage);
  currentImageRef.current = currentImage;

  // FC-040 post-turn flash fix. Skia's useImage keeps returning the STALE
  // previous image while it async-re-decodes a changed URL (see usePageImages:
  // `current`/`next`/`prev` are independent useImage hooks, so after a commit the
  // `current` slot re-fetches instead of inheriting the already-decoded `next`).
  // So `currentImage` still points at the page we turned AWAY from for a few
  // frames after commit. If the settle layer is removed on the curl-reset alone,
  // the un-hidden flat layer draws that stale previous page → a brief flash.
  // We capture the image being left at turn start and hold the settle layer (it
  // shows the correct target page) until `currentImage` moves off it.
  const leavingImageRef = useRef<SkImage | null>(null);
  // Set true by the UI-thread reaction once the curl values have reset; consumed
  // by the image-gated clear effect below (which also waits for the fresh image).
  const [curlReset, setCurlReset] = useState(false);
  const onCurlReset = useCallback(() => setCurlReset(true), []);

  useLayoutEffect(() => {
    // Canonical rest after any commit / resize: flat current page, forward mode.
    // Resets the curl values. If we are mid-settle (settleShared), arm the exit
    // reaction: pointer/origin are now reset, so it is safe to un-hide the live
    // layers on the next UI frame. isAnimating is cleared here too (a resize
    // while animating should never wedge it shut). The settle gate itself is NOT
    // cleared here — the reaction below does that, gated on the UI thread having
    // applied this reset, so no un-hidden frame renders against stale curl
    // values.
    origin.value = width;
    pointer.value = width;
    isBackward.value = false;
    isAnimating.value = false;
    // FC-040 review fix (HIGH): release the JS-thread busy latch in lock-step
    // with isAnimating — the reset lands after every commit/resize, so the next
    // turn (or dot-jump) is admitted only once the state machine is fully at rest.
    busy.current = false;
    if (settleShared.value) settleClearReady.value = true;
    setDirection('forward');
  }, [currentPage, width, origin, pointer, isBackward, isAnimating, settleShared, settleClearReady, busy]);

  // Exit gate: clear the settle state only after useLayoutEffect has reset the
  // curl values AND armed settleClearReady (both flush to the UI thread in the
  // same batch). This is the cross-thread barrier that guarantees the
  // reveal/curl layers never un-hide against stale curl values.
  const finishSettle = useCallback(() => {
    setSettling(false);
    setSettleImage(null);
    setCurlReset(false);
  }, []);

  // FC-040 review fix (HIGH): clear the JS-thread busy latch from the animation's
  // cancel (!finished) branch. That branch runs on the UI thread, so it must hop
  // back via runOnJS to release the latch — otherwise a cancelled turn (resize /
  // interrupt) would leave `busy` stuck true and wedge all further taps.
  const clearBusy = useCallback(() => {
    busy.current = false;
  }, [busy]);

  useAnimatedReaction(
    () => settleShared.value && settleClearReady.value,
    (ready, prev) => {
      if (ready && !prev) {
        settleShared.value = false;
        settleClearReady.value = false;
        // Signal that the curl values have reset on the UI thread. We do NOT
        // clear the settle layer here — the image-gated effect below waits for
        // the freshly-committed page to actually be decoded first, else the live
        // layer would flash the stale previous page (see leavingImageRef).
        runOnJS(onCurlReset)();
      }
    },
    []
  );

  // FC-040 flash fix: clear the settle gate only once BOTH (a) the curl values
  // have reset (curlReset, from the reaction above) AND (b) the newly-committed
  // page image is live — i.e. `currentImage` has changed off the page we left.
  // Until then the settle layer keeps showing the correct target page.
  useEffect(() => {
    if (!settling || !curlReset) return;
    if (currentImage === leavingImageRef.current) return; // fresh page not decoded yet
    finishSettle();
  }, [settling, curlReset, currentImage, finishSettle]);

  // Safety backstop: never hold the settle layer indefinitely — e.g. if the new
  // page's image URL fails to load, `currentImage` never refreshes. Release after
  // a bounded wait so subsequent taps keep working; the settle layer shows the
  // target page meanwhile, so the worst case degrades to the original brief flash.
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(finishSettle, TURN_MS + 500);
    return () => clearTimeout(t);
  }, [settling, finishSettle]);

  // JS-thread commit: freeze the target page as the settle image + hide the
  // live layers + advance the page — all in one React commit so the frozen
  // full-screen page and the new currentPage are consistent (no wrong-page
  // frame between them).
  const commitForward = useCallback(() => {
    const target = currentPage + 1;
    // FC-040 review fix (MEDIUM): the settle gate can only be cleared by the
    // useLayoutEffect that re-runs when currentPage changes. Entering the gate
    // when the target equals the current page (React bails out of the state
    // update → effect never re-runs) would wedge `settling=true` forever and
    // freeze the reader on the settle image. The turn-entry boundary guard makes
    // this impossible today, but we guard defensively: only arm the gate when
    // the page will actually change. If it won't, unwind cleanly.
    if (target === currentPage || target >= totalPages) {
      settleShared.value = false;
      busy.current = false;
      isAnimating.value = false;
      return;
    }
    setSettleImage(nextImageRef.current);
    setSettling(true);
    onPageChange(target);
  }, [currentPage, totalPages, onPageChange, settleShared, busy, isAnimating]);

  const commitBackward = useCallback(() => {
    // Backward target is the PREVIOUS page (it peels in on top and becomes the
    // new current page after onPageChange(currentPage - 1)).
    const target = currentPage - 1;
    // See commitForward: never arm the settle gate on a no-op page change.
    if (target === currentPage || target < 0) {
      settleShared.value = false;
      busy.current = false;
      isAnimating.value = false;
      return;
    }
    setSettleImage(previousImageRef.current);
    setSettling(true);
    onPageChange(target);
  }, [currentPage, onPageChange, settleShared, busy, isAnimating]);

  // Fire-and-forget forward turn: current page peels off the right edge to reveal
  // the next page beneath. Direction/images are set on the JS thread BEFORE the
  // animation begins, so no wrong-image frame precedes the first animated frame.
  const turnForward = useCallback(() => {
    // FC-040 review fix (HIGH): synchronous busy check+set BEFORE the async
    // shared-value write, so a double-tap can't slip a second turn through the
    // race window between `isAnimating.value = true` and its batched flush.
    if (busy.current || isAnimating.value) return;
    // FC-040 review fix (MEDIUM): the settle gate can only clear when
    // useLayoutEffect re-runs, which requires currentPage to actually change.
    // This boundary guard is what guarantees the target page differs — enter the
    // animation (and the gate) only when there is a real page to turn to.
    if (currentPage >= totalPages - 1) return;
    // Record the page we're leaving so the settle gate can wait for the new page
    // to actually decode before un-hiding the live layers (flash fix).
    leavingImageRef.current = currentImageRef.current;
    busy.current = true;
    isAnimating.value = true;
    isBackward.value = false;
    setDirection('forward');
    origin.value = width;
    pointer.value = width;
    pointer.value = withTiming(
      0,
      { duration: TURN_MS, easing: Easing.inOut(Easing.cubic) },
      (finished) => {
        'worklet';
        if (finished) {
          settleShared.value = true;
          runOnJS(commitForward)();
        } else {
          isAnimating.value = false;
          runOnJS(clearBusy)();
        }
      }
    );
  }, [currentPage, totalPages, width, origin, pointer, isBackward, isAnimating, settleShared, commitForward, busy, clearBusy]);

  // Fire-and-forget backward turn: the previous page un-peels in from the left
  // over the current page. Start fully curled (pointer=0) with images already
  // swapped, then sweep pointer 0→width.
  const turnBackward = useCallback(() => {
    // FC-040 review fix (HIGH): synchronous busy check+set BEFORE the async
    // shared-value write (see turnForward).
    if (busy.current || isAnimating.value) return;
    // FC-040 review fix (MEDIUM): boundary guard guarantees the target page
    // differs, so the commit always changes currentPage and the settle gate's
    // useLayoutEffect re-runs to clear it — the gate can't wedge.
    if (currentPage <= 0) return;
    // Record the page we're leaving (flash fix — see turnForward + leavingImageRef).
    leavingImageRef.current = currentImageRef.current;
    busy.current = true;
    isAnimating.value = true;
    isBackward.value = true;
    setDirection('backward');
    origin.value = width;
    pointer.value = 0;
    pointer.value = withTiming(
      width,
      { duration: TURN_MS, easing: Easing.inOut(Easing.cubic) },
      (finished) => {
        'worklet';
        if (finished) {
          settleShared.value = true;
          runOnJS(commitBackward)();
        } else {
          isAnimating.value = false;
          runOnJS(clearBusy)();
        }
      }
    );
  }, [currentPage, width, origin, pointer, isBackward, isAnimating, settleShared, commitBackward, busy, clearBusy]);

  // JS-thread tap router. Computes the zone and navigates. Kept on the JS thread
  // because resolveTapZone is a plain (non-worklet) function and the turn/toggle
  // handlers already run here — see the crash note on the gesture below.
  const handleTapAt = useCallback(
    (x: number, y: number) => {
      // FC-040 review fix (HIGH): the tap's y + chrome-band geometry route a tap
      // over the (visible) ✕ or dots bar to 'none' so the underlying RN Pressable
      // owns it and the Curl neither turns nor toggles. When controls are hidden
      // the bands are 0/ignored and the full-height edge/center zones apply.
      const zone = resolveTapZone(x, width, y, {
        controlsVisible,
        topBandHeight,
        bottomBandHeight,
        height,
      });
      if (zone === 'backward') turnBackward();
      else if (zone === 'forward') turnForward();
      else if (zone === 'toggle') onTap();
      // zone === 'none': chrome band — do nothing; the Pressable handles it.
    },
    [width, height, controlsVisible, topBandHeight, bottomBandHeight, turnForward, turnBackward, onTap]
  );

  // FC-040: single Tap gesture routes by horizontal position. No Pan gesture —
  // the finger-tracked drag curl was removed. Zones: left 20% back / center 60%
  // toggle bars / right 20% forward (see tapZones.ts). Taps during an in-flight
  // animation are dropped by the isAnimating guard inside turnForward/Backward.
  //
  // CRASH HOTFIX: react-native-gesture-handler runs `.onEnd` as a WORKLET on the
  // UI thread. `resolveTapZone` is a plain JS function, and calling a non-worklet
  // from a worklet is a fatal crash in release builds (Hermes + Reanimated worklet
  // runtime) — it only "worked" in dev because dev mode is lenient. So the worklet
  // does nothing but hop to the JS thread via runOnJS; the zone computation and
  // navigation happen there (turnForward/Backward/onTap already ran on the JS
  // thread via runOnJS before, so behavior is unchanged).
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(8)
        .onEnd((e) => {
          'worklet';
          runOnJS(handleTapAt)(e.x, e.y);
        }),
    [handleTapAt]
  );

  // Forward: current curls away, next revealed beneath. Backward: previous curls
  // in on top, current revealed beneath.
  const curlImage = direction === 'backward' ? previousImage : currentImage;
  const revealImage = direction === 'backward' ? currentImage : nextImage;

  const uniforms = useDerivedValue(
    () => ({
      pointer: pointer.value * pd,
      origin: origin.value * pd,
      resolution: [width * pd, height * pd],
      container: [0, 0, width * pd, height * pd],
      cornerRadius: CORNER_RADIUS * pd,
    }),
    [width, height, pd]
  );

  const imageRect = useMemo(() => Skia.XYWHRect(0, 0, width, height), [width, height]);

  // Opacity for the sharp page revealed beneath the curl. Only show it while a
  // curl is mid-transition; at rest the current page's transparent contain
  // margins would otherwise let the revealed page bleed through (FC-026).
  // Forward: reveal NEXT while pointer has left origin. Backward: reveal CURRENT
  // (the base page) only while the previous page is partway across (0<pointer<
  // width) — gating on `width` (not just `isBackward`) prevents a one-frame
  // bleed at the backward start where pointer is still width.
  const revealOpacity = useDerivedValue(() =>
    isBackward.value
      ? pointer.value > 0 && pointer.value < width
        ? 1
        : 0
      : pointer.value < origin.value
        ? 1
        : 0
  );

  // FC-040: while settling, hide the live reveal + curl layers so the frozen
  // settle layer owns the screen. This gate is plain React state (not a shared
  // value) so it flips in the SAME React commit that swaps in the new page
  // images and mounts the settle layer — the entry into settle is therefore
  // atomic (no inter-thread window where the live layers render new images
  // against stale curl values). The exit un-hide is deferred by the
  // useAnimatedReaction until the UI thread has applied the curl reset.
  const liveOpacity = settling ? 0 : 1;

  return (
    <GestureDetector gesture={tap}>
      <View style={[styles.container, { width, height }]}>
        <Canvas style={{ width, height }}>
          <Rect x={0} y={0} width={width} height={height} color="black" />

          {/* Ambient backdrop fills the contain letterbox margins for the whole
              reader. Based on the current page; updates on commit. */}
          {currentImage && (
            <AmbientBackdrop image={currentImage} rect={imageRect} width={width} height={height} />
          )}

          {/* Sharp page revealed beneath the curl (forward: next, backward:
              current). Contain so baked text is never cropped; opacity-gated so
              it can't bleed through the curling page's transparent margins or
              flash the wrong page during the settle handoff. */}
          {revealImage && (
            <Group opacity={liveOpacity}>
              <Group opacity={revealOpacity}>
                <SkiaImage image={revealImage} rect={imageRect} fit="contain" />
              </Group>
            </Group>
          )}

          {/* The curling page (forward: current peels away; backward: previous
              peels in). Only the sharp contained image lives in the shader
              layer — the ambient backdrop stays behind it (see above). At rest
              (pointer=origin=width) this layer draws the flat current page. */}
          {curlImage && (
            <Group opacity={liveOpacity}>
              <Group transform={[{ scale: 1 / pd }]}>
                <Group
                  layer={
                    <Paint>
                      <RuntimeShader source={pageCurl} uniforms={uniforms} />
                    </Paint>
                  }
                  transform={[{ scale: pd }]}
                >
                  <SkiaImage image={curlImage} rect={imageRect} fit="contain" />
                </Group>
              </Group>
            </Group>
          )}

          {/* FC-040 settle layer: the frozen full-screen target page, rendered
              on top ONLY while `settling` (React state, set atomically with the
              page swap). Covers the reveal/curl layers during the commit handoff
              so no partially-peeled/stale frame leaks through. It is the same
              decoded SkImage the flat curl layer shows after the reset, so the
              handoff is pixel-identical. */}
          {settling && settleImage && (
            <SkiaImage image={settleImage} rect={imageRect} fit="contain" />
          )}
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#000',
  },
});
