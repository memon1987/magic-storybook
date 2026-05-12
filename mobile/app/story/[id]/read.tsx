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
import { Curl, type TapZone } from '../../../components/PageCurl/Curl';
import { usePageImages } from '../../../components/PageCurl/usePageImages';

const CONTROLS_TIMEOUT_MS = 4000;

export default function ReadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const { width, height } = useWindowDimensions();

  const [currentPage, setCurrentPage] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [orientation, setOrientation] = useState<ScreenOrientation.Orientation | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confettiFiredFor = useRef<number | null>(null);
  const confettiRef = useRef<ConfettiCannon | null>(null);

  const { data: story, isLoading, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => getStory(id!),
    enabled: !!id,
  });

  // FC-012: prepend the cover (title page) as page 0 when present. Older
  // stories without titlePageImageUrl render unchanged. We synthesize a
  // StoryPage so the existing render iteration / dot indicator / page-curl
  // logic doesn't need to learn about a separate cover concept.
  const pages: StoryPage[] = useMemo(() => {
    const contentPages = story?.pages ?? [];
    if (story?.titlePageImageUrl) {
      const coverPage: StoryPage = {
        pageNumber: 0,
        text: story.titlePage?.text ?? story.title ?? '',
        imageUrl: story.titlePageImageUrl,
      };
      return [coverPage, ...contentPages];
    }
    return contentPages;
  }, [story?.titlePageImageUrl, story?.titlePage?.text, story?.title, story?.pages]);
  const isLastPage = pages.length > 0 && currentPage === pages.length - 1;
  const isPortrait = orientation === ScreenOrientation.Orientation.PORTRAIT_UP
    || orientation === ScreenOrientation.Orientation.PORTRAIT_DOWN
    || height > width;

  const pageImages = usePageImages(pages, currentPage);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      } catch {
        // some devices/simulators reject the lock
      }
      const initial = await ScreenOrientation.getOrientationAsync();
      if (!cancelled) setOrientation(initial);
    })();

    const sub = ScreenOrientation.addOrientationChangeListener((evt) => {
      setOrientation(evt.orientationInfo.orientation);
    });

    return () => {
      cancelled = true;
      ScreenOrientation.removeOrientationChangeListener(sub);
      ScreenOrientation.unlockAsync().catch(() => {});
    };
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
    if (isLastPage && confettiFiredFor.current !== currentPage) {
      confettiFiredFor.current = currentPage;
      confettiRef.current?.start();
    }
  }, [isLastPage, currentPage]);

  const goToPage = (index: number) => {
    if (index < 0 || index >= pages.length) return;
    setCurrentPage(index);
    setControlsVisible(true);
  };

  const handleTap = (zone: TapZone) => {
    if (zone === 'left') {
      goToPage(currentPage - 1);
    } else if (zone === 'right') {
      goToPage(currentPage + 1);
    } else {
      setControlsVisible((v) => !v);
    }
  };

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

  if (isPortrait) {
    return (
      <View style={styles.portraitOverlay}>
        <Ionicons name="phone-landscape" size={64} color="#FFFFFF" />
        <Text style={styles.portraitTitle}>Rotate your device</Text>
        <Text style={styles.portraitSubtitle}>
          Stories read best in landscape mode.
        </Text>
        <Pressable onPress={() => router.back()} style={styles.portraitCloseButton}>
          <Ionicons name="close" size={20} color="#FFFFFF" />
          <Text style={styles.portraitCloseText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Curl
        width={width}
        height={height}
        currentImage={pageImages.current}
        nextImage={pageImages.next}
        currentPage={currentPage}
        totalPages={pages.length}
        onPageChange={handlePageChange}
        onTap={handleTap}
      />

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
            {currentPage + 1} / {pages.length}
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

      {isLastPage && (
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
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
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
  portraitOverlay: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  portraitTitle: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 22,
    color: '#FFFFFF',
    marginTop: 8,
  },
  portraitSubtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
  },
  portraitCloseButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    marginTop: 16,
  },
  portraitCloseText: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});
