import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { getStory } from '../../../services/api';
import { Colors } from '../../../constants/Colors';

export default function PreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const { data: story, isLoading, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => getStory(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.primary} />
        <Text style={styles.loadingText}>Loading story...</Text>
      </View>
    );
  }

  if (error || !story) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="alert-circle" size={48} color={Colors.light.error} />
        <Text style={styles.errorText}>Failed to load story</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => router.back()}>
          <Text style={styles.retryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: story.title,
          headerRight: () => (
            <TouchableOpacity
              onPress={() => router.push(`/story/${id}/read`)}
              style={styles.readButton}
            >
              <Text style={styles.readButtonText}>Read</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.savedBanner}>
          <Ionicons name="checkmark-circle" size={20} color={Colors.light.secondary} />
          <Text style={styles.savedBannerText}>Saved to My Stories</Text>
        </View>

        <View style={styles.header}>
          <Text style={styles.title}>{story.title}</Text>
          <Text style={styles.subtitle}>
            A story for {story.childName} featuring {story.specialFriendName
              ? `${story.specialFriendName} the ${story.specialFriendDescription}`
              : `a ${story.favoriteAnimal}`}
          </Text>
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="book-outline" size={16} color={Colors.light.textSecondary} />
              <Text style={styles.metaText}>{story.pageCount} pages</Text>
            </View>
            <View style={styles.metaItem}>
              <Ionicons name="heart-outline" size={16} color={Colors.light.textSecondary} />
              <Text style={styles.metaText}>{story.moral}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Pages Preview</Text>

        {story.pages?.map((page, index) => (
          <View key={index} style={styles.pageCard}>
            <Image
              source={{ uri: page.imageUrl }}
              style={styles.pageImage}
              contentFit="cover"
            />
            <View style={styles.pageContent}>
              <Text style={styles.pageNumber}>Page {page.pageNumber}</Text>
              <Text style={styles.pageText}>{page.text}</Text>
            </View>
          </View>
        ))}

        <TouchableOpacity
          style={styles.startReadingButton}
          onPress={() => router.push(`/story/${id}/read`)}
        >
          <Ionicons name="play" size={20} color="#FFFFFF" />
          <Text style={styles.startReadingText}>Start Reading</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.goToLibraryButton}
          onPress={() => router.replace('/(tabs)')}
        >
          <Ionicons name="library" size={20} color={Colors.light.secondary} />
          <Text style={styles.goToLibraryText}>Go to My Stories</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.light.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: Colors.light.textSecondary,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.light.background,
    padding: 20,
  },
  errorText: {
    fontSize: 18,
    color: Colors.light.text,
    marginTop: 12,
  },
  retryButton: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: Colors.light.primary,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  readButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  readButtonText: {
    color: Colors.light.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: Colors.light.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.light.textSecondary,
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 20,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    fontSize: 14,
    color: Colors.light.textSecondary,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.light.text,
    marginBottom: 16,
  },
  pageCard: {
    backgroundColor: Colors.light.card,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  pageImage: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
  pageContent: {
    padding: 16,
  },
  pageNumber: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.light.primary,
    marginBottom: 8,
  },
  pageText: {
    fontSize: 16,
    color: Colors.light.text,
    lineHeight: 24,
  },
  startReadingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.light.primary,
    padding: 18,
    borderRadius: 12,
    marginTop: 16,
    gap: 8,
  },
  startReadingText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  savedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5E9',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 20,
    gap: 8,
  },
  savedBannerText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.light.secondary,
  },
  goToLibraryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.light.card,
    padding: 18,
    borderRadius: 12,
    marginTop: 12,
    gap: 8,
    borderWidth: 1.5,
    borderColor: Colors.light.secondary,
  },
  goToLibraryText: {
    color: Colors.light.secondary,
    fontSize: 18,
    fontWeight: '700',
  },
});
