import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
import ConfettiCannon from 'react-native-confetti-cannon';
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { getStory, StoryPage } from '../../../services/api';
import { useTheme } from '../../../contexts/ThemeContext';
import { GradientBackground } from '../../../components/GradientBackground';
import { AnimatedPressable } from '../../../components/AnimatedPressable';
import { SplashScreenAnimated } from '../../../components/SplashScreenAnimated';
import { Curl } from '../../../components/PageCurl/Curl';
import { usePageImages } from '../../../components/PageCurl/usePageImages';
import { readerPageLabel } from '../../../components/PageCurl/paging';

const CONTROLS_TIMEOUT_MS = 4000;

export default function ReadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const { width, height } = useWindowDimensions();

  const [currentPage, setCurrentPage] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  // Brief, non-blocking "best in landscape" hint that auto-dismisses. Unlike the
  // old blocking overlay, this never traps the reader if the landscape lock fails.
  const [hintVisible, setHintVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confettiFiredFor = useRef<number | null>(null);
  const confettiRef = useRef<ConfettiCannon | null>(null);

  const { data: story, isLoading, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => getStory(id!),
    enabled: !!id,
  });

  // FC-012: prepend the cover (title page) as page 0 when present. FC-022:
  // append a synthetic "The End" page after the last content page. Older
  // stories without titlePageImageUrl render unchanged. We synthesize these as
  // StoryPages so the existing render iteration / dot indicator / page-curl
  // logic doesn't need to learn about separate cover/end concepts — the end
  // page just carries no image (Curl paints it solid black).
  const hasCover = !!story?.titlePageImageUrl;
  const hasEndPage = (story?.pages?.length ?? 0) > 0;
  const pages: StoryPage[] = useMemo(() => {
    const contentPages = story?.pages ?? [];
    const base: StoryPage[] = story?.titlePageImageUrl
      ? [
          {
            pageNumber: 0,
            text: story.titlePage?.text ?? story.title ?? '',
            imageUrl: story.titlePageImageUrl,
          },
          ...contentPages,
        ]
      : contentPages;
    if (contentPages.length === 0) return base;
    // Synthetic end page: pageNumber -1 + empty imageUrl are sentinels. This
    // object is local to this useMemo and never persisted/read by other
    // consumers; the empty imageUrl makes usePageImages return null (black page).
    const endPage: StoryPage = { pageNumber: -1, text: '', imageUrl: '' };
    return [...base, endPage];
  }, [story?.titlePageImageUrl, story?.titlePage?.text, story?.title, story?.pages]);
  // FC-022: the ending is a distinct page the user turns to — not an overlay on
  // the last story page (which made that page unreadable).
  const isEndPage = hasEndPage && currentPage === pages.length - 1;
  // Pure layout signal — always reflects the actually-rendered orientation,
  // independent of whether the OS honored the landscape lock.
  const isPortrait = height > width;

  const pageImages = usePageImages(pages, currentPage);

  useEffect(() => {
    // Best-effort: force landscape. The lock can be rejected (iPad multitasking,
    // simulators, device rotation-lock). We don't gate rendering on it — the
    // reader is fully dimension-driven and renders fine either way.
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch((e) => {
      console.warn('Reader: failed to lock to landscape', e);
    });
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, []);

  // Auto-dismiss the landscape hint shortly after open.
  useEffect(() => {
    const t = setTimeout(() => setHintVisible(false), 3500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!controlsVisible) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_TIMEOUT_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [controlsVisible, currentPage]);

  useEffect(() => {
    if (isEndPage && confettiFiredFor.current !== currentPage) {
      confettiFiredFor.current = currentPage;
      confettiRef.current?.start();
    }
  }, [isEndPage, currentPage]);

  const goToPage = (index: number) => {
    if (index < 0 || index >= pages.length) return;
    setCurrentPage(index);
    setControlsVisible(true);
  };

  // FC-029: tap only toggles the controls — it never navigates. Page turns are
  // the curl swipe (forward + backward); the dots row jumps to any page.
  const handleTap = () => setControlsVisible((v) => !v);

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    setControlsVisible(true);
  };

  if (isLoading || !id) {
    return <SplashScreenAnimated loadingText="Opening your story…" progress={0.3} />;
  }

  if (error || !story) {
    return (
      <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
        <View style={styles.errorWrap}>
          <Ionicons name="alert-circle" size={48} color={palette.colors.accent} />
          <Text style={[styles.errorText, { color: palette.colors.textDark }]}>
            Failed to load story
          </Text>
          <AnimatedPressable
            onPress={() => router.back()}
            style={[styles.errorButton, { backgroundColor: palette.colors.accent }]}
          >
            <Text style={styles.errorButtonText}>Go Back</Text>
          </AnimatedPressable>
        </View>
      </GradientBackground>
    );
  }

  return (
    <View style={styles.container}>
      {/* FC-020: narration is baked into each illustration; Curl just renders + curls images. */}
      <Curl
        width={width}
        height={height}
        currentImage={pageImages.current}
        nextImage={pageImages.next}
        previousImage={pageImages.prev}
        currentPage={currentPage}
        totalPages={pages.length}
        onPageChange={handlePageChange}
        onTap={handleTap}
      />

      {isPortrait && hintVisible && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          style={styles.landscapeHint}
          pointerEvents="none"
        >
          <Ionicons name="phone-landscape" size={18} color="#FFFFFF" />
          <Text style={styles.landscapeHintText}>Best read in landscape</Text>
        </Animated.View>
      )}

      {controlsVisible && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          style={styles.topBar}
          pointerEvents="box-none"
        >
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeIconButton}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {story.title}
          </Text>
          <View style={styles.closeIconButton} />
        </Animated.View>
      )}

      {controlsVisible && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          style={styles.bottomBar}
          pointerEvents="box-none"
        >
          <View style={styles.dotsRow}>
            {pages.map((_, idx) => (
              <PageDot
                key={idx}
                index={idx}
                active={idx === currentPage}
                color={palette.colors.accent}
                onPress={() => goToPage(idx)}
              />
            ))}
          </View>
          <Text style={styles.pageCounter}>
            {readerPageLabel({
              index: currentPage,
              pageCount: pages.length,
              hasCover,
              hasEndPage,
            })}
          </Text>
        </Animated.View>
      )}

      <ConfettiCannon
        ref={(r) => {
          confettiRef.current = r;
        }}
        count={120}
        origin={{ x: width / 2, y: 0 }}
        autoStart={false}
        fadeOut
        explosionSpeed={350}
        fallSpeed={2800}
      />

      {isEndPage && (
        <Animated.View
          entering={FadeIn.delay(600).duration(400)}
          style={styles.endOverlay}
          pointerEvents="box-none"
        >
          <View style={[styles.endCard, { backgroundColor: palette.colors.cardBg }]}>
            <Text style={[styles.endTitle, { color: palette.colors.textDark }]}>The End</Text>
            <Text style={[styles.endSubtitle, { color: palette.colors.textMuted }]}>
              Hope you enjoyed {story.title}
            </Text>
            <AnimatedPressable
              onPress={() => router.replace('/(tabs)')}
              style={[styles.endButton, { backgroundColor: palette.colors.accent }]}
            >
              <Ionicons name="library" size={18} color="#FFFFFF" />
              <Text style={styles.endButtonText}>Back to Library</Text>
            </AnimatedPressable>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

interface PageDotProps {
  index: number;
  active: boolean;
  color: string;
  onPress: () => void;
}

function PageDot({ active, color, onPress }: PageDotProps) {
  const w = useSharedValue(active ? 22 : 8);
  useEffect(() => {
    w.value = withSpring(active ? 22 : 8, { damping: 18, stiffness: 220 });
  }, [active, w]);

  const style = useAnimatedStyle(() => ({
    width: w.value,
  }));

  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Animated.View
        style={[
          styles.dot,
          style,
          { backgroundColor: active ? color : 'rgba(255,255,255,0.4)' },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  closeIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: 'Nunito_700Bold',
    fontSize: 16,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    gap: 8,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  pageCounter: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
  },
  endOverlay: {
    // FC-022: the end page itself is solid black (no image), so no scrim is
    // needed — the card sits on the clean black page.
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endCard: {
    width: '70%',
    maxWidth: 420,
    padding: 28,
    borderRadius: 24,
    alignItems: 'center',
    gap: 8,
  },
  endTitle: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 32,
  },
  endSubtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  endButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 22,
    height: 52,
    borderRadius: 999,
  },
  endButtonText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  errorText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 18,
    textAlign: 'center',
  },
  errorButton: {
    marginTop: 8,
    paddingHorizontal: 22,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorButtonText: {
    color: '#FFFFFF',
    fontFamily: 'Nunito_700Bold',
    fontSize: 15,
  },
  landscapeHint: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  landscapeHintText: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
});
