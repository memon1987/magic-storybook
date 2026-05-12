import React from 'react';
import { View, Text, StyleSheet, ViewStyle, StyleProp } from 'react-native';
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
            <Ionicons name="book" size={36} color={palette.colors.textMuted} />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text
          style={[styles.title, { color: palette.colors.textDark }]}
          numberOfLines={2}
        >
          {story.title}
        </Text>

        <View style={styles.metaRow}>
          <View style={[styles.badge, { backgroundColor: palette.colors.secondary }]}>
            <Text style={[styles.badgeText, { color: palette.colors.textDark }]} numberOfLines={1}>
              {story.childName}
            </Text>
          </View>
          <Text style={[styles.pages, { color: palette.colors.textMuted }]}>
            {story.pageCount} pages
          </Text>
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
  },
});
