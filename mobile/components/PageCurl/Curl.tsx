import React, { useLayoutEffect, useMemo, useState } from 'react';
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
  withTiming,
  withSpring,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { pageCurl } from './pageCurl';

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
  // FC-029: tap is decoupled from navigation — it only toggles the reader
  // controls. Page turns happen via the curl swipe (forward + backward).
  onTap: () => void;
}

const CORNER_RADIUS = 0;
const COMMIT_THRESHOLD_RATIO = 0.25;
const CURL_ANIMATION_MS = 300;

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
  // Worklet-readable mirror of `direction`. The shader/gesture math runs on the
  // UI thread and can't read React state, so we drive it from this shared value
  // and keep `direction` in sync (one render per swipe) to swap the rendered
  // curl/reveal images. See FC-029 plan: forward peels the CURRENT page to
  // reveal NEXT; backward un-peels the PREVIOUS page over CURRENT.
  const isBackward = useSharedValue(false);
  const [direction, setDirection] = useState<Direction>('forward');

  const commitForward = () => onPageChange(currentPage + 1);
  const commitBackward = () => onPageChange(currentPage - 1);
  const setForward = () => setDirection('forward');

  useLayoutEffect(() => {
    // Canonical rest after any commit / resize: flat current page, forward mode.
    origin.value = width;
    pointer.value = width;
    isBackward.value = false;
    setDirection('forward');
  }, [currentPage, width, origin, pointer, isBackward]);

  const canForward = currentPage < totalPages - 1;
  const canBackward = currentPage > 0;

  const tap = Gesture.Tap()
    .maxDistance(8)
    .onEnd(() => {
      runOnJS(onTap)();
    });

  const pan = Gesture.Pan()
    .maxPointers(1)
    .activeOffsetX([-10, 10])
    .onStart((e) => {
      // activeOffsetX gates activation at ±10px, so translationX's sign here is
      // the drag direction. Right drag = backward (bring previous page in).
      const backward = e.translationX > 0;
      isBackward.value = backward;
      if (backward) {
        // Backward: anchor origin at the right edge and drive pointer 0→width as
        // the finger moves right, so the fold sweeps left→right and the previous
        // page fills in from the left. Start flat (pointer=width) for one frame
        // so the about-to-swap reveal image doesn't flash before `direction`
        // updates.
        origin.value = width;
        pointer.value = width;
      } else {
        origin.value = e.x;
        pointer.value = e.x;
      }
      runOnJS(setDirection)(backward ? 'backward' : 'forward');
    })
    .onChange((e) => {
      if (isBackward.value) {
        pointer.value = Math.max(0, Math.min(width, e.translationX));
      } else {
        pointer.value = Math.max(0, Math.min(origin.value, e.x));
      }
    })
    .onEnd(() => {
      if (isBackward.value) {
        const progress = pointer.value / Math.max(1, width);
        if (canBackward && progress > COMMIT_THRESHOLD_RATIO) {
          pointer.value = withTiming(
            width,
            { duration: CURL_ANIMATION_MS, easing: Easing.out(Easing.cubic) },
            (finished) => {
              if (finished) runOnJS(commitBackward)();
            }
          );
        } else {
          // Cancel: peel the previous page back off to the left, then collapse
          // to an identity rest (origin=pointer ⇒ no curl) showing current.
          pointer.value = withSpring(0, { damping: 18, stiffness: 200 }, (finished) => {
            if (finished) {
              origin.value = pointer.value;
              runOnJS(setForward)();
            }
          });
        }
      } else {
        const progress = (origin.value - pointer.value) / Math.max(1, width);
        if (canForward && progress > COMMIT_THRESHOLD_RATIO) {
          pointer.value = withTiming(
            0,
            { duration: CURL_ANIMATION_MS, easing: Easing.out(Easing.cubic) },
            (finished) => {
              if (finished) runOnJS(commitForward)();
            }
          );
        } else {
          pointer.value = withSpring(origin.value, { damping: 18, stiffness: 200 });
        }
      }
    });

  const composed = Gesture.Race(pan, tap);

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

  // Opacity for the sharp page revealed beneath the curl.
  // Forward: show NEXT only while a curl is in progress (pointer left origin) —
  // at rest the current page's transparent contain margins would otherwise let
  // next bleed through (FC-026). Backward: CURRENT is the base page and must
  // stay visible beneath the incoming previous page throughout the turn.
  const revealOpacity = useDerivedValue(() =>
    isBackward.value ? 1 : pointer.value < origin.value ? 1 : 0
  );

  return (
    <GestureDetector gesture={composed}>
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
              it can't bleed through the curling page's transparent margins. */}
          {revealImage && (
            <Group opacity={revealOpacity}>
              <SkiaImage image={revealImage} rect={imageRect} fit="contain" />
            </Group>
          )}

          {/* The curling page (forward: current peels away; backward: previous
              peels in). Only the sharp contained image lives in the shader
              layer — the ambient backdrop stays behind it (see above). */}
          {curlImage && (
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
