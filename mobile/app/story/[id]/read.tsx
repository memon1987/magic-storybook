import { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { getStory, StoryPage } from '../../../services/api';
import { Colors } from '../../../constants/Colors';

export default function ReadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const { data: story, isLoading, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => getStory(id!),
    enabled: !!id,
  });

  const pages = story?.pages || [];

  const handleScroll = (event: any) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const pageIndex = Math.round(offsetX / SCREEN_WIDTH);
    setCurrentPage(pageIndex);
  };

  const goToPage = (index: number) => {
    if (index >= 0 && index < pages.length) {
      flatListRef.current?.scrollToIndex({ index, animated: true });
    }
  };

  const handlePrevious = () => goToPage(currentPage - 1);
  const handleNext = () => goToPage(currentPage + 1);

  // Full-page image rendering - text is embedded in the illustration
  const renderPage = ({ item }: { item: StoryPage }) => (
    <View style={{
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#000000',
    }}>
      <Image
        source={{ uri: item.imageUrl }}
        style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}
        contentFit="contain"
      />
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.accent} />
      </View>
    );
  }

  if (error || !story) {
    return (
      <SafeAreaView style={styles.errorContainer}>
        <Ionicons name="alert-circle" size={48} color={Colors.light.error} />
        <Text style={styles.errorText}>Failed to load story</Text>
        <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
          <Text style={styles.closeButtonText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header - semi-transparent overlay */}
      <SafeAreaView style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={() => router.back()}>
          <Ionicons name="close" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {story.title}
        </Text>
        <View style={styles.headerButton} />
      </SafeAreaView>

      {/* Full-page images with embedded text */}
      <FlatList
        key={`${SCREEN_WIDTH}-${SCREEN_HEIGHT}`}
        ref={flatListRef}
        data={pages}
        renderItem={renderPage}
        keyExtractor={(item, index) => `page-${index}`}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        initialScrollIndex={currentPage}
        getItemLayout={(data, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
      />

      {/* Navigation Controls - semi-transparent overlay */}
      <SafeAreaView style={styles.footer}>
        <TouchableOpacity
          style={[styles.navButton, currentPage === 0 && styles.navButtonDisabled]}
          onPress={handlePrevious}
          disabled={currentPage === 0}
        >
          <Ionicons
            name="chevron-back"
            size={24}
            color={currentPage === 0 ? 'rgba(255,255,255,0.3)' : '#FFFFFF'}
          />
        </TouchableOpacity>

        <View style={styles.pageIndicator}>
          <Text style={styles.pageIndicatorText}>
            {currentPage + 1} / {pages.length}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.navButton, currentPage === pages.length - 1 && styles.navButtonDisabled]}
          onPress={handleNext}
          disabled={currentPage === pages.length - 1}
        >
          <Ionicons
            name="chevron-forward"
            size={24}
            color={currentPage === pages.length - 1 ? 'rgba(255,255,255,0.3)' : '#FFFFFF'}
          />
        </TouchableOpacity>
      </SafeAreaView>

      {/* Page Dots */}
      <View style={styles.dotsContainer}>
        {pages.map((_, index) => (
          <TouchableOpacity
            key={index}
            style={[styles.dot, currentPage === index && styles.dotActive]}
            onPress={() => goToPage(index)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.light.background,
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
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.text,
    marginTop: 12,
  },
  closeButton: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: Colors.light.primary,
    borderRadius: 8,
  },
  closeButtonText: {
    color: Colors.light.textOnPrimary,
    fontSize: 16,
    fontFamily: 'Nunito_600SemiBold',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  headerButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'Nunito_700Bold',
    color: '#FFFFFF',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
  },
  navButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.light.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  pageIndicator: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  pageIndicatorText: {
    fontSize: 16,
    fontFamily: 'Nunito_600SemiBold',
    color: '#FFFFFF',
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  dotActive: {
    backgroundColor: Colors.light.accent,
    width: 24,
  },
});
