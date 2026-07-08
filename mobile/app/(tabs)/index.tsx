import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Alert,
  Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { getStories, deleteStory, Story } from '../../services/api';
import { useTheme } from '../../contexts/ThemeContext';
import { useResponsive } from '../../hooks/useResponsive';
import { GradientBackground } from '../../components/GradientBackground';
import { StoryCard } from '../../components/StoryCard';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { deleteDisplayTitle } from '../../utils/storyDisplayTitle';

// FC-039: light haptics on edit-mode entry + delete confirm. Lazily required
// (same pattern as the FC-029 social-sign-in native modules) so a dev client /
// TestFlight build 13 that predates the expo-haptics native module degrades to
// silent no-haptics instead of crashing; full haptics arrive with the next EAS
// build. Expo Go bundles expo-haptics, so it works there today.
function lightHaptic() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Haptics = require('expo-haptics');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // no-op: module unavailable in this build
  }
}

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { palette } = useTheme();
  const { gutter, insets, gridColumns } = useResponsive();
  const { columns, cellWidth, gap } = gridColumns();

  // FC-031 Change 1 — library live-update via refetchInterval. The
  // FC-017 plan promised the user "feel free to come back later — we'll
  // have it ready in your library." Before this, useQuery with no
  // refetchInterval + no Firestore subscription + no window-focus signal
  // on React Native left the library showing the same stale
  // 'generating' status forever. Now: while ANY row is non-terminal
  // (queued | generating), poll every 15s (matching the worker
  // heartbeat cadence). All-terminal → polling stops. Cost: ~4
  // list-fetches/min while the user is on this screen with anything
  // in-flight. Cheaper than a per-doc Firestore subscription for the
  // current load profile; revisit when scale demands it.
  const { data: stories = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['stories'],
    queryFn: getStories,
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as Story[];
      const anyInFlight = rows.some(
        (s) => s.status === 'queued' || s.status === 'generating'
      );
      return anyInFlight ? 15_000 : false;
    },
  });

  // FC-039: edit mode is LOCAL to this screen (no context/store). Long-press
  // any card → enter; Done / empty-space tap / blur / last-story-deleted → exit.
  const [isEditing, setIsEditing] = useState(false);

  // FC-039: optimistic delete. Previously this only invalidated on success;
  // now the card disappears immediately (onMutate removes it from the cache),
  // rolls back on error, and reconciles with the server on settle. cancelQueries
  // in onMutate + invalidateQueries in onSettled guard against the FC-031 15s
  // refetchInterval landing mid-flight and resurrecting the deleted row.
  const deleteMutation = useMutation({
    mutationFn: deleteStory,
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ['stories'] });
      const previous = queryClient.getQueryData<Story[]>(['stories']);
      queryClient.setQueryData<Story[]>(['stories'], (old) =>
        (old ?? []).filter((s) => s.id !== id)
      );
      return { previous };
    },
    onError: (error, _id, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['stories'], ctx.previous);
      }
      const message = error instanceof Error ? error.message : 'Failed to delete story';
      Alert.alert('Error', message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['stories'] }),
  });

  // FC-017 Phase 4: route by status. complete → reader; queued/generating/failed
  // → generating screen (which subscribes to the doc and shows progress or the
  // Resume affordance for failed).
  const handleStoryPress = useCallback(
    (story: Story) => {
      if (story.status === 'complete') {
        router.push(`/story/${story.id}/read`);
      } else {
        router.push(`/story/${story.id}/generating`);
      }
    },
    [router]
  );

  // FC-039: long-press now ENTERS edit mode (no direct delete). Long-press
  // while already editing is a no-op.
  const handleStoryLongPress = useCallback((_story: Story) => {
    setIsEditing((editing) => {
      if (!editing) lightHaptic();
      return true;
    });
  }, []);

  // FC-039: badge tap (or VoiceOver "delete" action) → confirm Alert →
  // optimistic delete. Confirm-dialog (not undo-snackbar) is the pre-made
  // decision: stories cost ~$0.50–$1 and minutes to regenerate.
  const handleDeleteRequest = useCallback(
    (story: Story) => {
      const displayTitle = deleteDisplayTitle(story);
      Alert.alert(
        'Delete this story?',
        `"${displayTitle}" will be permanently removed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              lightHaptic();
              deleteMutation.mutate(story.id);
            },
          },
        ]
      );
    },
    [deleteMutation]
  );

  // FC-039: leaving the tab / navigating away exits edit mode.
  useFocusEffect(
    useCallback(() => () => setIsEditing(false), [])
  );

  // FC-039: deleting the last story auto-exits edit mode (empty state renders).
  useEffect(() => {
    if (isEditing && stories.length === 0) {
      setIsEditing(false);
    }
  }, [isEditing, stories.length]);

  const renderItem = useCallback(
    ({ item, index }: { item: Story; index: number }) => (
      <View style={{ width: cellWidth }}>
        <StoryCard
          story={item}
          onPress={handleStoryPress}
          onLongPress={handleStoryLongPress}
          editMode={isEditing}
          onDeletePress={handleDeleteRequest}
          jigglePhaseIndex={index}
        />
      </View>
    ),
    [cellWidth, handleStoryPress, handleStoryLongPress, isEditing, handleDeleteRequest]
  );

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.cardBg]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 12,
            paddingLeft: gutter + insets.left,
            paddingRight: gutter + insets.right,
          },
        ]}
      >
        <View style={styles.headerLeft}>
          <Text style={[styles.title, { color: palette.colors.textDark }]}>My Library</Text>
          <Text style={[styles.subtitle, { color: palette.colors.textMuted }]}>
            Tap a story to start reading
          </Text>
        </View>
        {/* FC-039: while editing, a "Done" pill REPLACES the count badge. */}
        {isEditing ? (
          <AnimatedPressable
            onPress={() => setIsEditing(false)}
            style={[styles.donePill, { backgroundColor: palette.colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Done editing"
          >
            <Text style={styles.doneText}>Done</Text>
          </AnimatedPressable>
        ) : (
          <View style={[styles.countBadge, { backgroundColor: palette.colors.primary }]}>
            <Text style={[styles.countText, { color: palette.colors.textDark }]}>
              {stories.length}
            </Text>
          </View>
        )}
      </View>

      <FlatList
        // RN requires a fresh key when numColumns changes, else it asserts.
        // Resetting scroll position on rotation is acceptable for a library.
        key={`grid-${columns}`}
        data={stories}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        numColumns={columns}
        // FC-039: FlatList must re-render rows when edit mode toggles.
        extraData={isEditing}
        columnWrapperStyle={{ gap, marginBottom: gap }}
        contentContainerStyle={[
          styles.listContent,
          // FC-039: grow the content so the footer Pressable fills the space
          // below the last row, giving a tap target to exit edit mode.
          styles.listContentGrow,
          { paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right },
          stories.length === 0 && styles.listContentEmpty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={palette.colors.accent}
          />
        }
        ListEmptyComponent={
          !isLoading ? (
            <EmptyState
              palette={palette.colors}
              onCreate={() => router.push('/(tabs)/create')}
            />
          ) : null
        }
        // FC-039: empty space below the last row is an exit-edit-mode surface.
        // A no-op onPress when not editing keeps the tap inert. Do NOT move this
        // to the FlatList onTouchStart — that bubbles from card touches and
        // would swallow badge taps.
        ListFooterComponent={
          stories.length > 0 ? (
            <Pressable
              style={styles.footerExit}
              onPress={() => {
                if (isEditing) setIsEditing(false);
              }}
            />
          ) : null
        }
      />
    </GradientBackground>
  );
}

interface EmptyStateProps {
  palette: {
    primary: string;
    accent: string;
    textDark: string;
    textMuted: string;
  };
  onCreate: () => void;
}

function EmptyState({ palette, onCreate }: EmptyStateProps) {
  const bounce = useSharedValue(0);

  useEffect(() => {
    bounce.value = withRepeat(
      withSequence(
        withTiming(-10, { duration: 700, easing: Easing.inOut(Easing.cubic) }),
        withTiming(0, { duration: 700, easing: Easing.inOut(Easing.cubic) })
      ),
      -1,
      true
    );
  }, [bounce]);

  const arrowStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bounce.value }],
  }));

  return (
    <View style={styles.emptyWrap}>
      <View style={[styles.emptyIcon, { backgroundColor: palette.primary }]}>
        <Ionicons name="book" size={48} color={palette.textDark} />
      </View>
      <Text style={[styles.emptyTitle, { color: palette.textDark }]}>No stories yet</Text>
      <Text style={[styles.emptySubtitle, { color: palette.textMuted }]}>
        Tap the Create tab below to make your first magical story.
      </Text>
      <AnimatedPressable
        onPress={onCreate}
        style={[styles.emptyCta, { backgroundColor: palette.accent }]}
      >
        <Ionicons name="sparkles" size={18} color="#FFFFFF" />
        <Text style={styles.emptyCtaText}>Create Your First Story</Text>
      </AnimatedPressable>
      <Animated.View style={[styles.arrowDown, arrowStyle]}>
        <Ionicons name="arrow-down" size={28} color={palette.textMuted} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingBottom: 16,
  },
  headerLeft: {
    flex: 1,
  },
  title: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 28,
  },
  subtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
    marginTop: 2,
  },
  countBadge: {
    minWidth: 36,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 16,
  },
  // FC-039: Done pill replaces the count badge while editing.
  donePill: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  listContent: {
    paddingBottom: 100,
  },
  // FC-039: let the footer Pressable fill remaining space as an exit surface.
  listContentGrow: {
    flexGrow: 1,
  },
  listContentEmpty: {
    flex: 1,
  },
  // FC-039: empty space below the last row exits edit mode when tapped.
  footerExit: {
    flexGrow: 1,
    minHeight: 80,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
    paddingBottom: 60,
  },
  emptyIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  emptyTitle: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 22,
    marginTop: 6,
  },
  emptySubtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    textAlign: 'center',
  },
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    height: 52,
    borderRadius: 999,
    marginTop: 12,
  },
  emptyCtaText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  arrowDown: {
    marginTop: 16,
  },
});
