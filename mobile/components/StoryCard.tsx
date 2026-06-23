import React from 'react';
import { View, Text, StyleSheet, ViewStyle, StyleProp, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';
import { useTheme } from '../contexts/ThemeContext';
import { Story } from '../services/api';

interface StoryCardProps {
  story: Story;
  onPress: (story: Story) => void;
  onLongPress?: (story: Story) => void;
  style?: StyleProp<ViewStyle>;
}

export function StoryCard({ story, onPress, onLongPress, style }: StoryCardProps) {
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

  return (
    <AnimatedPressable
      onPress={() => onPress(story)}
      onLongPress={onLongPress ? () => onLongPress(story) : undefined}
      style={[styles.card, { backgroundColor: palette.colors.cardBg }, style]}
    >
      <View style={[styles.coverWrap, { backgroundColor: palette.colors.background }]}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={styles.cover} contentFit="cover" />
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
});
