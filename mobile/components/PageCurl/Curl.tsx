import React, { useLayoutEffect, useMemo } from 'react';
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

export type TapZone = 'left' | 'center' | 'right';

interface CurlProps {
  width: number;
  height: number;
  currentImage: SkImage | null;
  nextImage: SkImage | null;
  currentPage: number;
  totalPages: number;
  onPageChange: (newPage: number) => void;
  onTap: (zone: TapZone) => void;
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
  currentPage,
  totalPages,
  onPageChange,
  onTap,
}: CurlProps) {
  const pd = PixelRatio.get();

  const origin = useSharedValue(width);
  const pointer = useSharedValue(width);

  const commitPage = () => onPageChange(currentPage + 1);

  useLayoutEffect(() => {
    origin.value = width;
    pointer.value = width;
  }, [currentPage, width, origin, pointer]);

  const canCommitRef = currentPage < totalPages - 1;

  const tap = Gesture.Tap()
    .maxDistance(8)
    .onEnd((e) => {
      const zone: TapZone =
        e.x < width * 0.25 ? 'left' : e.x > width * 0.75 ? 'right' : 'center';
      runOnJS(onTap)(zone);
    });

  const pan = Gesture.Pan()
    .maxPointers(1)
    .activeOffsetX([-10, 10])
    .onStart((e) => {
      origin.value = e.x;
      pointer.value = e.x;
    })
    .onChange((e) => {
      pointer.value = Math.max(0, Math.min(origin.value, e.x));
    })
    .onEnd(() => {
      const progress = (origin.value - pointer.value) / Math.max(1, width);
      const shouldCommit = canCommitRef && progress > COMMIT_THRESHOLD_RATIO;

      if (shouldCommit) {
        pointer.value = withTiming(
          0,
          { duration: CURL_ANIMATION_MS, easing: Easing.out(Easing.cubic) },
          (finished) => {
            if (finished) {
              runOnJS(commitPage)();
            }
          }
        );
      } else {
        pointer.value = withSpring(origin.value, {
          damping: 18,
          stiffness: 200,
        });
      }
    });

  const composed = Gesture.Race(pan, tap);

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

          {/* Next page, revealed under the curl. Sharp + contain (never crops
              baked text); its transparent margins reveal the ambient backdrop. */}
          {nextImage && (
            <SkiaImage image={nextImage} rect={imageRect} fit="contain" />
          )}

          {/* Current page curls away. Only the sharp contained image lives in
              the shader layer — the backdrop stays behind it (see above). */}
          {currentImage && (
            <Group transform={[{ scale: 1 / pd }]}>
              <Group
                layer={
                  <Paint>
                    <RuntimeShader source={pageCurl} uniforms={uniforms} />
                  </Paint>
                }
                transform={[{ scale: pd }]}
              >
                <SkiaImage image={currentImage} rect={imageRect} fit="contain" />
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
