import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
}

const CORNER_RADIUS = 0;
// FC-040: one shared self-running curl duration for both directions. Tuned on
// device (450–600 window per the plan).
const TURN_MS = 500;

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
}: CurlProps) {
  const pd = PixelRatio.get();

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
    if (settleShared.value) settleClearReady.value = true;
    setDirection('forward');
  }, [currentPage, width, origin, pointer, isBackward, isAnimating, settleShared, settleClearReady]);

  // Exit gate: clear the settle state only after useLayoutEffect has reset the
  // curl values AND armed settleClearReady (both flush to the UI thread in the
  // same batch). This is the cross-thread barrier that guarantees the
  // reveal/curl layers never un-hide against stale curl values.
  const finishSettle = useCallback(() => {
    setSettling(false);
    setSettleImage(null);
  }, []);

  useAnimatedReaction(
    () => settleShared.value && settleClearReady.value,
    (ready, prev) => {
      if (ready && !prev) {
        settleShared.value = false;
        settleClearReady.value = false;
        runOnJS(finishSettle)();
      }
    },
    []
  );

  // JS-thread commit: freeze the target page as the settle image + hide the
  // live layers + advance the page — all in one React commit so the frozen
  // full-screen page and the new currentPage are consistent (no wrong-page
  // frame between them).
  const commitForward = useCallback(() => {
    setSettleImage(nextImageRef.current);
    setSettling(true);
    onPageChange(currentPage + 1);
  }, [currentPage, onPageChange]);

  const commitBackward = useCallback(() => {
    // Backward target is the PREVIOUS page (it peels in on top and becomes the
    // new current page after onPageChange(currentPage - 1)).
    setSettleImage(previousImageRef.current);
    setSettling(true);
    onPageChange(currentPage - 1);
  }, [currentPage, onPageChange]);

  // Fire-and-forget forward turn: current page peels off the right edge to reveal
  // the next page beneath. Direction/images are set on the JS thread BEFORE the
  // animation begins, so no wrong-image frame precedes the first animated frame.
  const turnForward = useCallback(() => {
    if (isAnimating.value) return;
    if (currentPage >= totalPages - 1) return;
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
        }
      }
    );
  }, [currentPage, totalPages, width, origin, pointer, isBackward, isAnimating, settleShared, commitForward]);

  // Fire-and-forget backward turn: the previous page un-peels in from the left
  // over the current page. Start fully curled (pointer=0) with images already
  // swapped, then sweep pointer 0→width.
  const turnBackward = useCallback(() => {
    if (isAnimating.value) return;
    if (currentPage <= 0) return;
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
        }
      }
    );
  }, [currentPage, width, origin, pointer, isBackward, isAnimating, settleShared, commitBackward]);

  // FC-040: single Tap gesture routes by horizontal position. No Pan gesture —
  // the finger-tracked drag curl was removed. Zones: left 20% back / center 60%
  // toggle bars / right 20% forward (see tapZones.ts). Taps during an in-flight
  // animation are dropped by the isAnimating guard inside turnForward/Backward.
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(8)
        .onEnd((e) => {
          const zone = resolveTapZone(e.x, width);
          if (zone === 'backward') {
            runOnJS(turnBackward)();
          } else if (zone === 'forward') {
            runOnJS(turnForward)();
          } else {
            runOnJS(onTap)();
          }
        }),
    [width, turnForward, turnBackward, onTap]
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
