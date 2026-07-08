import React, { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ViewStyle,
  StyleProp,
  ActivityIndicator,
  Platform,
  Pressable,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useReducedMotion,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { AnimatedPressable } from './AnimatedPressable';
import { useTheme } from '../contexts/ThemeContext';
import { Story } from '../services/api';
import { deleteDisplayTitle } from '../utils/storyDisplayTitle';

interface StoryCardProps {
  story: Story;
  onPress: (story: Story) => void;
  onLongPress?: (story: Story) => void;
  // FC-039: iOS-style edit mode. When editMode is true the card jiggles
  // (unless reduced-motion) and shows a top-left delete badge; body taps
  // are inert.
  editMode?: boolean;
  onDeletePress?: (story: Story) => void;
  jigglePhaseIndex?: number;
  style?: StyleProp<ViewStyle>;
}

export function StoryCard({
  story,
  onPress,
  onLongPress,
  editMode = false,
  onDeletePress,
  jigglePhaseIndex = 0,
  style,
}: StoryCardProps) {
  const { palette } = useTheme();
  // FC-012: prefer the dedicated cover image; fall back to pages[0] for stories
  // generated before FC-012 shipped (which never got a titlePageImageUrl).
  const coverUrl = story.titlePageImageUrl ?? story.pages?.[0]?.imageUrl;

  // FC-017 Phase 4: render non-complete states with status-specific
  // affordances. Tap behavior is set by the parent (library navigates
  // generating/queued/failed → /story/[id]/generating, complete → /read).
  const isGenerating = story.status === 'generating' || story.status === 'queued';
  const isFailed = story.status === 'failed';
  const displayTitle = story.title?.trim()
    ? story.title
    : isFailed
      ? `Couldn’t finish`
      : `Story for ${story.childName}`;

  // FC-039: staggered iOS home-screen jiggle. Reduced motion → no jiggle
  // (badge still renders). Bounded exposure — the animation is cancelled the
  // moment edit mode exits, and the parent also exits edit mode on blur.
  //
  // Review fix (FC-039 R1, MEDIUM): the stagger bucket is keyed on a STABLE
  // hash of story.id, NOT the volatile FlatList index. Using the list index
  // meant every card below a deleted one shifted index → its jiggle useEffect
  // re-ran → its animation restarted (visible re-sync flicker). jigglePhaseIndex
  // is now only a fallback seed; the phase is derived here and does not change
  // when siblings are removed.
  const phaseBucket = useMemo(() => {
    const key = story.id ?? String(jigglePhaseIndex);
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 4;
  }, [story.id, jigglePhaseIndex]);

  const rotation = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (editMode && !reducedMotion) {
      rotation.value = withDelay(
        phaseBucket * 60,
        withRepeat(
          withSequence(
            withTiming(-1.5, { duration: 120, easing: Easing.inOut(Easing.quad) }),
            withTiming(1.5, { duration: 120, easing: Easing.inOut(Easing.quad) })
          ),
          -1,
          true
        )
      );
    } else {
      cancelAnimation(rotation);
      rotation.value = withTiming(0, { duration: 100 });
    }
  }, [editMode, reducedMotion, phaseBucket, rotation]);

  const jiggleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const handleDeletePress = () => onDeletePress?.(story);

  return (
    // FC-039: the outer wrapper carries the jiggle transform. Its bounds equal
    // the card's (no extra padding), so the card is NOT shifted within its
    // fixed-width grid cell. The delete badge is a SIBLING rendered AFTER (over)
    // the card so styles.card's overflow:'hidden' cannot clip it, while it still
    // sits INSIDE the wrapper's bounds — which matters because Android does not
    // deliver touches to a child positioned outside its parent's bounds (iOS
    // does). The badge is therefore inset just inside the card's top-left corner
    // (positive offset), not hanging outside it (the old top:-6/left:-6 badge
    // was untappable on Android; R1 HIGH).
    <Animated.View style={jiggleStyle}>
      <AnimatedPressable
        onPress={editMode ? undefined : () => onPress(story)}
        onLongPress={onLongPress ? () => onLongPress(story) : undefined}
        // FC-039: neutralize the press-scale bounce while editing so an inert
        // body tap doesn't animate as if it did something.
        pressedScale={editMode ? 1 : undefined}
        style={[styles.card, { backgroundColor: palette.colors.cardBg }, style]}
        // FC-039: VoiceOver users can delete without long-press or edit mode.
        // Present in BOTH modes, routing to the same confirm flow.
        accessibilityActions={[{ name: 'delete', label: 'Delete story' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'delete') onDeletePress?.(story);
        }}
      >
        <View style={[styles.coverWrap, { backgroundColor: palette.colors.background }]}>
          {coverUrl ? (
            // FC-038: mirror the FC-026 reader fix at card scale — blurred
            // cover-fit backdrop + dim + contain foreground, so the baked-in
            // title text is never cropped by the fixed 3:4 box. Both layers
            // share the same URI so the network fetch is deduped; note the
            // backdrop's blur transform FORKS the cache key, so it is a
            // separate decode + transform + cache entry (~2 decodes/cover).
            //
            // Review retune (2026-07-07): expo-image's `blurRadius` is applied
            // in SOURCE-PIXEL space, not display points. Without help, a ~1024px
            // Gemini cover in a ~110–170pt card blurs at full decode res BEFORE
            // downscale, and iOS additionally HALVES the prop internally — so
            // radius 16 rendered as a near-sharp ghost duplicate of the cover
            // (doubled title text), not a frosted bed. Fixes:
            //   • iOS: `enforceEarlyResizing` (iOS-only prop) resizes to the
            //     container BEFORE the blur, moving it into ~display space (and
            //     cutting the full-res transform cost). iOS halves the value and
            //     now operates at view size, so we raise it to 20 (~10pt effective).
            //   • Android: `BlurTransformation(min(r,25),4)` already runs at a
            //     4× downsample (heavy frost) and clamps at 25, so a LOWER value
            //     (8) reads equivalently without over-blurring to mush.
            // Final on-device appearance still depends on real Gemini source
            // resolution (backend does not pin size until FC-028) → on-device
            // screenshot tuning is an explicit pre-EAS-build gate (PR body).
            <>
              <Image
                source={{ uri: coverUrl }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                blurRadius={Platform.select({ ios: 20, android: 8, default: 16 })}
                enforceEarlyResizing
                transition={150}
              />
              <View style={[StyleSheet.absoluteFill, styles.coverDim]} />
              <Image source={{ uri: coverUrl }} style={styles.cover} contentFit="contain" />
            </>
          ) : (
            <View style={styles.placeholder}>
              <Ionicons
                name={isFailed ? 'cloud-offline-outline' : 'book'}
                size={36}
                color={palette.colors.textMuted}
              />
            </View>
          )}
          {isGenerating && (
            <View style={styles.statusOverlay}>
              <View style={[styles.statusChip, { backgroundColor: palette.colors.accent }]}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.statusChipText}>Generating…</Text>
              </View>
            </View>
          )}
          {isFailed && (
            <View style={styles.statusOverlay}>
              <View style={[styles.statusChip, { backgroundColor: palette.colors.accent }]}>
                <Ionicons name="refresh" size={12} color="#fff" />
                <Text style={styles.statusChipText}>Tap to retry</Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.info}>
          <Text
            style={[styles.title, { color: palette.colors.textDark }]}
            numberOfLines={2}
          >
            {displayTitle}
          </Text>

          <View style={styles.metaRow}>
            <View style={[styles.badge, { backgroundColor: palette.colors.secondary }]}>
              <Text style={[styles.badgeText, { color: palette.colors.textDark }]} numberOfLines={1}>
                {story.childName}
              </Text>
            </View>
            {story.status === 'complete' && story.pageCount !== undefined && (
              <Text style={[styles.pages, { color: palette.colors.textMuted }]}>
                {story.pageCount} pages
              </Text>
            )}
            {isGenerating && story.progress?.message && (
              <Text
                style={[styles.pages, { color: palette.colors.textMuted }]}
                numberOfLines={1}
              >
                {story.progress.message}
              </Text>
            )}
          </View>
        </View>
      </AnimatedPressable>

      {/* FC-039: delete badge — rendered only in edit mode, as a SIBLING over
          the card (a child of the jiggle wrapper). Being a sibling keeps it
          outside styles.card's overflow:'hidden' (not clipped) while staying
          within the wrapper's bounds; positioned at a POSITIVE inset inside the
          card corner so the badge + hitSlop remain within parent bounds and are
          tappable on Android (R1 HIGH fix). See styles.deleteBadge for the
          geometry. */}
      {editMode && (
        <Pressable
          style={[styles.deleteBadge, { backgroundColor: palette.colors.accent }]}
          hitSlop={12}
          onPress={handleDeletePress}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${deleteDisplayTitle(story)}`}
          accessibilityHint="Opens a confirmation to permanently delete this story"
        >
          <Ionicons name="remove" size={18} color="#fff" />
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  coverWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  // FC-038: mutes the blurred backdrop so the sharp contain-fit foreground
  // pops (reader uses 0.35; cards sit on a light UI, so 0.25).
  coverDim: {
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  title: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 14,
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    maxWidth: '70%',
  },
  badgeText: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 11,
  },
  pages: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 11,
    flex: 1,
  },
  // FC-017 Phase 4: status overlay sits at the bottom of the cover image.
  statusOverlay: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    alignItems: 'center',
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusChipText: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 11,
    color: '#fff',
  },
  // FC-039: iOS-style delete badge inset inside the card's top-left corner.
  // Rendered as a sibling OVER the card so styles.card's overflow:'hidden' can't
  // clip it, and it stays within the jiggle wrapper's bounds so Android delivers
  // its touches (Android drops touches outside a parent's bounds; the old
  // top:-6/left:-6 badge was untappable on Android). Positioned at top/left:12
  // with hitSlop:12 so the 24pt circle's full touch rect spans (0,0)→(48,48) —
  // entirely inside the wrapper (= card bounds), and a 48pt effective target
  // (> Apple's 44pt min). The wrapper adds NO padding, so there is no card shift
  // vs the pre-FC-039 baseline.
  deleteBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
});
