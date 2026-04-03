import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { getStories, deleteStory, Story } from '../../services/api';
import { Colors } from '../../constants/Colors';

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: stories = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['stories'],
    queryFn: getStories,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to delete story';
      Alert.alert('Error', message);
    },
  });

  const handleStoryPress = (story: Story) => {
    router.push(`/story/${story.id}/read`);
  };

  const handleDeletePress = (story: Story) => {
    Alert.alert(
      'Delete Story',
      `Are you sure you want to delete "${story.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate(story.id),
        },
      ]
    );
  };

  const renderStory = ({ item }: { item: Story }) => (
    <TouchableOpacity
      style={styles.storyCard}
      onPress={() => handleStoryPress(item)}
      onLongPress={() => handleDeletePress(item)}
    >
      <View style={styles.storyImageContainer}>
        {item.pages && item.pages[0]?.imageUrl ? (
          <Image
            source={{ uri: item.pages[0].imageUrl }}
            style={styles.storyImage}
            contentFit="cover"
          />
        ) : (
          <View style={styles.storyImagePlaceholder}>
            <Ionicons name="book" size={40} color={Colors.light.textLight} />
          </View>
        )}
      </View>
      <View style={styles.storyInfo}>
        <Text style={styles.storyTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.storyMeta}>
          For {item.childName} • {item.pageCount} pages
        </Text>
        <Text style={styles.storyDate}>
          {new Date(item.createdAt).toLocaleDateString()}
        </Text>
      </View>
    </TouchableOpacity>
  );

  const EmptyState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="book-outline" size={80} color={Colors.light.textLight} />
      <Text style={styles.emptyTitle}>No Stories Yet</Text>
      <Text style={styles.emptySubtitle}>
        Create your first magical storybook!
      </Text>
      <TouchableOpacity
        style={styles.createButton}
        onPress={() => router.push('/(tabs)/create')}
      >
        <Ionicons name="add" size={20} color={Colors.light.textOnPrimary} />
        <Text style={styles.createButtonText}>Create Story</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      {stories.length === 0 && !isLoading ? (
        <EmptyState />
      ) : (
        <FlatList
          data={stories}
          renderItem={renderStory}
          keyExtractor={(item) => item.id}
          numColumns={2}
          contentContainerStyle={styles.listContent}
          columnWrapperStyle={styles.row}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={Colors.light.accent}
            />
          }
          ListHeaderComponent={
            <Text style={styles.headerText}>
              {stories.length} {stories.length === 1 ? 'Story' : 'Stories'}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  listContent: {
    padding: 16,
  },
  row: {
    justifyContent: 'space-between',
  },
  headerText: {
    fontSize: 14,
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.textSecondary,
    marginBottom: 16,
  },
  storyCard: {
    width: '48%',
    backgroundColor: Colors.light.card,
    borderRadius: 16,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.light.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  storyImageContainer: {
    width: '100%',
    aspectRatio: 1,
  },
  storyImage: {
    width: '100%',
    height: '100%',
  },
  storyImagePlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: Colors.light.backgroundSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  storyInfo: {
    padding: 12,
  },
  storyTitle: {
    fontSize: 14,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.light.text,
    marginBottom: 4,
  },
  storyMeta: {
    fontSize: 12,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.textSecondary,
    marginBottom: 2,
  },
  storyDate: {
    fontSize: 11,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.textLight,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyTitle: {
    fontSize: 24,
    fontFamily: 'Baloo2_700Bold',
    color: Colors.light.text,
    marginTop: 20,
  },
  emptySubtitle: {
    fontSize: 16,
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.textSecondary,
    marginTop: 8,
    textAlign: 'center',
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.light.primary,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 24,
    gap: 8,
  },
  createButtonText: {
    color: Colors.light.textOnPrimary,
    fontSize: 16,
    fontFamily: 'Nunito_700Bold',
  },
});
