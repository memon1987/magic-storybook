/**
 * FC-017 Phase 3+4: live-progress screen.
 *
 * Subscribes to the Firestore story doc via onSnapshot. The doc is the
 * single source of truth for whether generation succeeded; the mobile
 * axios call only confirmed "request accepted" (the 202 from /generate or
 * /:id/resume). This is the silent-success bug fix surfaced as UX.
 *
 * State machine driven by `status`:
 *   queued | generating       → render progress.message + spinner
 *   complete                  → router.replace to /story/[id]/read
 *   failed                    → render error + Resume + Back-to-library
 *   subscription error        → render error + Back-to-library
 *
 * "Close — we'll have it ready when you're back" affordance pops to the
 * library; the subscription unsubscribes on unmount. The library renders
 * the story's current status row so the user can come back to it.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '../../../contexts/ThemeContext';
import { GradientBackground } from '../../../components/GradientBackground';
import { AnimatedPressable } from '../../../components/AnimatedPressable';
import { subscribeToStory, StorySubscriptionResult } from '../../../services/stories';
import { resumeStory, FailureCode } from '../../../services/api';

const FAILURE_COPY: Record<FailureCode, string> = {
  generation_error: 'Something went wrong while creating the story.',
  network_error: 'We lost the connection during generation.',
  quota_exceeded: 'We hit our generation limit. Please try again in a few minutes.',
  safety_blocked: 'We couldn’t create this one. Try different inputs.',
  sigterm: 'Generation was interrupted. You can try again.',
  orphaned: 'Generation didn’t finish. You can try again.',
  unknown: 'Something unexpected happened.',
};

export default function GeneratingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();

  const [result, setResult] = useState<StorySubscriptionResult | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // PR-29 HIGH-3: snapshot can fire multiple times; only auto-navigate ONCE
  // per id. Without this guard, a status flip back to 'generating' (e.g.
  // user hits Resume on a story we already navigated away from) would
  // call router.replace again on a different screen.
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    navigatedRef.current = false;
    const unsub = subscribeToStory(id, (next) => {
      setResult(next);
      if (!('error' in next) && next.status === 'complete' && !navigatedRef.current) {
        navigatedRef.current = true;
        router.replace(`/story/${id}/read`);
      }
    });
    return unsub;
  }, [id, router]);

  const onResume = async () => {
    if (!id || isResuming) return;
    setIsResuming(true);
    setResumeError(null);
    try {
      await resumeStory(id);
      // Stay on this screen; the subscription will reflect the new run.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start resume';
      setResumeError(message);
    } finally {
      setIsResuming(false);
    }
  };

  const onBackToLibrary = () => {
    router.replace('/(tabs)');
  };

  // First render before subscription connects.
  if (!result) {
    return (
      <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={palette.colors.accent} />
        </View>
      </GradientBackground>
    );
  }

  // Subscription-layer errors.
  if ('error' in result) {
    const errorCopy =
      result.error === 'not_found' ? 'We couldn’t find that story.' :
      result.error === 'permission_denied' ? 'You don’t have permission to view this story.' :
      'Something went wrong.';
    return (
      <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
        <View style={styles.center}>
          <Animated.View entering={FadeIn} style={[styles.card, { backgroundColor: palette.colors.cardBg }]}>
            <Ionicons name="alert-circle" size={48} color={palette.colors.accent} />
            <Text style={[styles.title, { color: palette.colors.textDark }]}>{errorCopy}</Text>
            <AnimatedPressable
              style={[styles.primaryButton, { backgroundColor: palette.colors.accent }]}
              onPress={onBackToLibrary}
            >
              <Text style={styles.primaryButtonText}>Back to library</Text>
            </AnimatedPressable>
          </Animated.View>
        </View>
      </GradientBackground>
    );
  }

  // Terminal failure: show Resume + Back-to-library.
  if (result.status === 'failed') {
    const code = result.failureReason ?? 'unknown';
    return (
      <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
        <View style={styles.center}>
          <Animated.View entering={FadeIn} style={[styles.card, { backgroundColor: palette.colors.cardBg }]}>
            <Ionicons name="cloud-offline-outline" size={48} color={palette.colors.accent} />
            <Text style={[styles.title, { color: palette.colors.textDark }]}>{FAILURE_COPY[code]}</Text>
            {resumeError && (
              <Text style={[styles.errorDetail, { color: palette.colors.textMuted }]}>{resumeError}</Text>
            )}
            <AnimatedPressable
              style={[styles.primaryButton, { backgroundColor: palette.colors.accent, opacity: isResuming ? 0.5 : 1 }]}
              onPress={onResume}
              disabled={isResuming}
            >
              <Text style={styles.primaryButtonText}>
                {isResuming ? 'Starting…' : 'Try again'}
              </Text>
            </AnimatedPressable>
            <Pressable onPress={onBackToLibrary} style={styles.secondaryButton}>
              <Text style={[styles.secondaryButtonText, { color: palette.colors.textMuted }]}>Back to library</Text>
            </Pressable>
          </Animated.View>
        </View>
      </GradientBackground>
    );
  }

  // status === 'queued' or 'generating': live progress.
  const message = result.progress?.message ?? 'Starting…';
  const completed = result.progress?.completedSteps ?? 0;
  const total = result.progress?.totalSteps ?? 0;
  const showFraction = total > 0;

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
      <View style={styles.center}>
        <Animated.View entering={FadeIn} exiting={FadeOut} style={[styles.card, { backgroundColor: palette.colors.cardBg }]}>
          <ActivityIndicator size="large" color={palette.colors.accent} />
          <Text style={[styles.title, { color: palette.colors.textDark }]}>{message}</Text>
          {showFraction && (
            <Text style={[styles.fraction, { color: palette.colors.textMuted }]}>
              {completed} of {total}
            </Text>
          )}
          <Text style={[styles.hint, { color: palette.colors.textMuted }]}>
            This usually takes 2–5 minutes. Feel free to come back later — we’ll have it ready in your library.
          </Text>
          <Pressable onPress={onBackToLibrary} style={styles.secondaryButton}>
            <Text style={[styles.secondaryButtonText, { color: palette.colors.textMuted }]}>Close</Text>
          </Pressable>
        </Animated.View>
      </View>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: 28,
    borderRadius: 24,
    alignItems: 'center',
    gap: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
  },
  fraction: {
    fontSize: 14,
    fontWeight: '500',
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 18,
  },
  errorDetail: {
    fontSize: 12,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  primaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 999,
    marginTop: 12,
    minWidth: 180,
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
