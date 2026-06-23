import { useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
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

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { palette } = useTheme();
  const { gutter, insets, gridColumns } = useResponsive();
  const { columns, cellWidth, gap } = gridColumns();

  const { data: stories = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['stories'],
    queryFn: getStories,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stories'] }),
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to delete story';
      Alert.alert('Error', message);
    },
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

  const handleStoryLongPress = useCallback(
    (story: Story) => {
      const displayTitle = story.title?.trim() || `Story for ${story.childName}`;
      Alert.alert('Delete Story', `Remove "${displayTitle}" from your library?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate(story.id),
        },
      ]);
    },
    [deleteMutation]
  );

  const renderItem = useCallback(
    ({ item }: { item: Story }) => (
      <View style={{ width: cellWidth }}>
        <StoryCard
          story={item}
          onPress={handleStoryPress}
          onLongPress={handleStoryLongPress}
        />
      </View>
    ),
    [cellWidth, handleStoryPress, handleStoryLongPress]
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
        <View style={[styles.countBadge, { backgroundColor: palette.colors.primary }]}>
          <Text style={[styles.countText, { color: palette.colors.textDark }]}>
            {stories.length}
          </Text>
        </View>
      </View>

      <FlatList
        // RN requires a fresh key when numColumns changes, else it asserts.
        // Resetting scroll position on rotation is acceptable for a library.
        key={`grid-${columns}`}
        data={stories}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        numColumns={columns}
        columnWrapperStyle={{ gap, marginBottom: gap }}
        contentContainerStyle={[
          styles.listContent,
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
  listContent: {
    paddingBottom: 100,
  },
  listContentEmpty: {
    flex: 1,
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
