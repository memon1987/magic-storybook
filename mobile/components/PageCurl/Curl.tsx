import React, { useLayoutEffect, useMemo } from 'react';
import { View, PixelRatio, StyleSheet } from 'react-native';
import {
  Canvas,
  Image as SkiaImage,
  Group,
  Paint,
  RuntimeShader,
  Skia,
  Rect,
  type SkImage,
  type SkTypefaceFontProvider,
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
import { PageTextLayer } from './PageTextLayer';
import { StoryPage, WritingStyleId } from '../../services/api';

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
  // FC-015: page data + Skia font provider for the narration overlay.
  // currentPageData/nextPageData drive the PageTextLayer rendered alongside
  // each image. writingStyle picks the font family. fontMgr is the Skia
  // typeface provider returned by useStoryFonts (null while loading; layer
  // renders nothing until ready).
  currentPageData?: StoryPage | null;
  nextPageData?: StoryPage | null;
  writingStyle?: WritingStyleId | null;
  fontMgr?: SkTypefaceFontProvider | null;
  textColor?: string;
  accentColor?: string;
  // FC-018: warm halo color (replaces backingColor). Used for the radial-
  // gradient halo behind center-overlay text + the warm-tint shadow on all
  // overlay text. Must be #RRGGBB (no alpha); alpha is added internally.
  haloColor?: string;
}

const CORNER_RADIUS = 0;
const COMMIT_THRESHOLD_RATIO = 0.25;
const CURL_ANIMATION_MS = 300;

export function Curl({
  width,
  height,
  currentImage,
  nextImage,
  currentPage,
  totalPages,
  onPageChange,
  onTap,
  currentPageData,
  nextPageData,
  writingStyle,
  fontMgr,
  textColor,
  accentColor,
  haloColor,
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

  // FC-015 / FC-018: defaults for the overlay colors when the parent doesn't
  // pass them explicitly. These are intentionally generic so the legacy code
  // path (no PageTextLayer rendered because no textPosition) is never affected.
  // haloColor default is a warm cream (matches the `magical` palette's
  // haloColor); callers should pass the active palette's haloColor explicitly.
  const resolvedTextColor = textColor ?? '#2D2D2D';
  const resolvedAccentColor = accentColor ?? '#FF6B6B';
  const resolvedHaloColor = haloColor ?? '#FFF4D6';

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.container, { width, height }]}>
        <Canvas style={{ width, height }}>
          <Rect x={0} y={0} width={width} height={height} color="black" />

          {/*
            FC-015 review fix MEDIUM-4: fit="cover" (was "contain") so the
            image fills the canvas with no letterbox bands. Otherwise the
            negative-space text positions Gemini reserves inside the image
            don't line up with the canvas-relative positions PageTextLayer
            uses — bottom-band text would float on a black letterbox bar
            instead of on the illustration's reserved zone. The story
            prompt already asks for landscape with central focal subjects,
            so cover-cropping the edges is acceptable.
          */}
          {nextImage && (
            <SkiaImage image={nextImage} rect={imageRect} fit="cover" />
          )}
          {/*
            FC-015: render the next page's text overlay with the underlay image
            so the user sees the next page's narration peeking through during
            the curl gesture (preserves the pre-read affordance).
          */}
          {nextImage && (
            <PageTextLayer
              page={nextPageData ?? null}
              writingStyle={writingStyle}
              fontMgr={fontMgr ?? null}
              width={width}
              height={height}
              accentColor={resolvedAccentColor}
              haloColor={resolvedHaloColor}
              textColor={resolvedTextColor}
            />
          )}

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
                <SkiaImage image={currentImage} rect={imageRect} fit="cover" />
                {/*
                  FC-015: PageTextLayer lives INSIDE the curl Group so the curl
                  shader composites image + text into the offscreen layer FIRST
                  and then deforms that composite. Text curls with the page —
                  no fade hack, no coordinate translation, real fonts.
                */}
                <PageTextLayer
                  page={currentPageData ?? null}
                  writingStyle={writingStyle}
                  fontMgr={fontMgr ?? null}
                  width={width}
                  height={height}
                  accentColor={resolvedAccentColor}
                  haloColor={resolvedHaloColor}
                  textColor={resolvedTextColor}
                />
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
