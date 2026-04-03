import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { generateStory, StoryInput, ArtStyle, StoryLength } from '../../services/api';
import { Colors } from '../../constants/Colors';

const SETTINGS = [
  { value: 'enchanted forest', label: 'Enchanted Forest' },
  { value: 'outer space', label: 'Outer Space' },
  { value: 'underwater kingdom', label: 'Underwater Kingdom' },
  { value: 'magical castle', label: 'Magical Castle' },
  { value: 'cozy village', label: 'Cozy Village' },
  { value: 'dinosaur land', label: 'Dinosaur Land' },
  { value: 'custom', label: 'Custom...' },
];

const MORALS = [
  { value: 'kindness', label: 'Kindness' },
  { value: 'bravery', label: 'Bravery' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'honesty', label: 'Honesty' },
  { value: 'friendship', label: 'Friendship' },
  { value: 'perseverance', label: 'Perseverance' },
  { value: 'custom', label: 'Custom...' },
];

const LENGTHS: { value: StoryLength; label: string; pages: string }[] = [
  { value: 'short', label: 'Short', pages: '4 pages' },
  { value: 'medium', label: 'Medium', pages: '6 pages' },
  { value: 'long', label: 'Long', pages: '8 pages' },
];

const ART_STYLES: { value: ArtStyle; label: string }[] = [
  { value: 'watercolor', label: 'Watercolor' },
  { value: 'cartoon', label: 'Cartoon' },
  { value: 'storybook-classic', label: 'Classic' },
  { value: 'claymation', label: 'Claymation' },
  { value: 'studio-ghibli', label: 'Ghibli' },
  { value: 'pixar-3d', label: 'Pixar 3D' },
];

const WRITING_STYLES = [
  { value: 'Dr. Seuss', label: 'Dr. Seuss' },
  { value: 'Eric Carle', label: 'Eric Carle' },
  { value: 'Maurice Sendak', label: 'Sendak' },
  { value: 'Shel Silverstein', label: 'Silverstein' },
  { value: 'Julia Donaldson', label: 'Donaldson' },
  { value: 'Roald Dahl', label: 'Roald Dahl' },
  { value: 'Beatrix Potter', label: 'Potter' },
  { value: 'Mo Willems', label: 'Mo Willems' },
  { value: 'custom', label: 'Custom...' },
];

export default function CreateStoryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Character fields
  const [childName, setChildName] = useState('');
  const [childGender, setChildGender] = useState<'boy' | 'girl' | null>(null);
  const [specialFriendName, setSpecialFriendName] = useState('');
  const [specialFriendDescription, setSpecialFriendDescription] = useState('');

  // Story settings
  const [setting, setSetting] = useState(SETTINGS[0].value);
  const [customSetting, setCustomSetting] = useState('');
  const [moral, setMoral] = useState(MORALS[0].value);
  const [customMoral, setCustomMoral] = useState('');
  const [length, setLength] = useState<StoryLength>('medium');

  // Style
  const [artStyle, setArtStyle] = useState<ArtStyle>('watercolor');
  const [authorStyle, setAuthorStyle] = useState<string | null>(null);
  const [customAuthorStyle, setCustomAuthorStyle] = useState('');

  const mutation = useMutation({
    mutationFn: generateStory,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
      router.push(`/story/${data.id}/preview`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to generate story';
      Alert.alert('Error', message);
    },
  });

  const handleCreate = () => {
    if (!childName.trim()) {
      Alert.alert('Missing Info', "Please enter the child's name");
      return;
    }
    if (!childGender) {
      Alert.alert('Missing Info', 'Please select boy or girl');
      return;
    }
    if (!specialFriendName.trim()) {
      Alert.alert('Missing Info', "Please enter the special friend's name");
      return;
    }
    if (!specialFriendDescription.trim()) {
      Alert.alert('Missing Info', 'Please describe what the special friend is');
      return;
    }

    const resolvedSetting = setting === 'custom' ? customSetting.trim() : setting;
    const resolvedMoral = moral === 'custom' ? customMoral.trim() : moral;

    if (!resolvedSetting) {
      Alert.alert('Missing Info', 'Please enter a custom setting');
      return;
    }
    if (!resolvedMoral) {
      Alert.alert('Missing Info', 'Please enter a custom moral / lesson');
      return;
    }

    const resolvedAuthorStyle =
      authorStyle === 'custom'
        ? customAuthorStyle.trim() || undefined
        : authorStyle || undefined;

    const input: StoryInput = {
      childName: childName.trim(),
      childGender,
      specialFriendName: specialFriendName.trim(),
      specialFriendDescription: specialFriendDescription.trim(),
      setting: resolvedSetting,
      moral: resolvedMoral,
      length,
      artStyle,
      authorStyle: resolvedAuthorStyle,
    };

    mutation.mutate(input);
  };

  if (mutation.isPending) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.accent} />
        <Text style={styles.loadingTitle}>Creating Your Story</Text>
        <Text style={styles.loadingSubtitle}>
          Our AI is writing and illustrating a magical story just for {childName || 'you'}...
        </Text>
        <Text style={styles.loadingHint}>This may take up to a minute</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Who is this story for?</Text>

      <Text style={styles.label}>Child's Name</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter the child's name"
        placeholderTextColor={Colors.light.textLight}
        value={childName}
        onChangeText={setChildName}
        autoCapitalize="words"
      />

      <Text style={styles.label}>Boy or Girl</Text>
      <View style={styles.optionsRow}>
        <TouchableOpacity
          style={[
            styles.genderButton,
            childGender === 'boy' && styles.optionButtonSelected,
          ]}
          onPress={() => setChildGender('boy')}
        >
          <Text
            style={[
              styles.optionText,
              childGender === 'boy' && styles.optionTextSelected,
            ]}
          >
            Boy
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.genderButton,
            childGender === 'girl' && styles.optionButtonSelected,
          ]}
          onPress={() => setChildGender('girl')}
        >
          <Text
            style={[
              styles.optionText,
              childGender === 'girl' && styles.optionTextSelected,
            ]}
          >
            Girl
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Special Friend's Name</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g., Whiskers, Teddy, Max"
        placeholderTextColor={Colors.light.textLight}
        value={specialFriendName}
        onChangeText={setSpecialFriendName}
        autoCapitalize="words"
      />

      <Text style={styles.label}>
        What is {specialFriendName || 'your special friend'}?
      </Text>
      <TextInput
        style={styles.input}
        placeholder="e.g., a fluffy orange cat, a stuffed teddy bear, best friend from school"
        placeholderTextColor={Colors.light.textLight}
        value={specialFriendDescription}
        onChangeText={setSpecialFriendDescription}
        autoCapitalize="none"
      />

      <Text style={styles.sectionTitle}>Story Settings</Text>

      <Text style={styles.label}>Setting</Text>
      <View style={styles.optionsGrid}>
        {SETTINGS.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.optionButton,
              setting === option.value && styles.optionButtonSelected,
            ]}
            onPress={() => setSetting(option.value)}
          >
            <Text
              style={[
                styles.optionText,
                setting === option.value && styles.optionTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {setting === 'custom' && (
        <TextInput
          style={[styles.input, styles.customInput]}
          placeholder="Describe your story setting..."
          placeholderTextColor={Colors.light.textLight}
          value={customSetting}
          onChangeText={setCustomSetting}
          autoCapitalize="sentences"
        />
      )}

      <Text style={styles.label}>Moral / Lesson</Text>
      <View style={styles.optionsGrid}>
        {MORALS.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.optionButton,
              moral === option.value && styles.optionButtonSelected,
            ]}
            onPress={() => setMoral(option.value)}
          >
            <Text
              style={[
                styles.optionText,
                moral === option.value && styles.optionTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {moral === 'custom' && (
        <TextInput
          style={[styles.input, styles.customInput]}
          placeholder="What lesson should the story teach?"
          placeholderTextColor={Colors.light.textLight}
          value={customMoral}
          onChangeText={setCustomMoral}
          autoCapitalize="sentences"
        />
      )}

      <Text style={styles.label}>Story Length</Text>
      <View style={styles.optionsRow}>
        {LENGTHS.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.lengthButton,
              length === option.value && styles.optionButtonSelected,
            ]}
            onPress={() => setLength(option.value)}
          >
            <Text
              style={[
                styles.optionText,
                length === option.value && styles.optionTextSelected,
              ]}
            >
              {option.label}
            </Text>
            <Text
              style={[
                styles.lengthPages,
                length === option.value && styles.optionTextSelected,
              ]}
            >
              {option.pages}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Style</Text>

      <Text style={styles.label}>Writing Style (optional)</Text>
      <View style={styles.artStyleGrid}>
        {WRITING_STYLES.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.artStyleButton,
              authorStyle === option.value && styles.optionButtonSelected,
            ]}
            onPress={() =>
              setAuthorStyle(authorStyle === option.value ? null : option.value)
            }
          >
            <Text
              style={[
                styles.optionText,
                authorStyle === option.value && styles.optionTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {authorStyle === 'custom' && (
        <TextInput
          style={[styles.input, styles.customInput]}
          placeholder="Enter an author or writing style..."
          placeholderTextColor={Colors.light.textLight}
          value={customAuthorStyle}
          onChangeText={setCustomAuthorStyle}
          autoCapitalize="words"
        />
      )}

      <Text style={styles.label}>Art Style</Text>
      <View style={styles.artStyleGrid}>
        {ART_STYLES.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.artStyleButton,
              artStyle === option.value && styles.optionButtonSelected,
            ]}
            onPress={() => setArtStyle(option.value)}
          >
            <Text
              style={[
                styles.optionText,
                artStyle === option.value && styles.optionTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.createButton} onPress={handleCreate}>
        <Text style={styles.createButtonText}>Create Story</Text>
      </TouchableOpacity>
    </ScrollView>
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
  sectionTitle: {
    fontSize: 20,
    fontFamily: 'Nunito_700Bold',
    color: Colors.light.text,
    marginTop: 16,
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.light.textSecondary,
    marginBottom: 8,
    marginTop: 8,
  },
  input: {
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.text,
  },
  customInput: {
    marginTop: 8,
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  artStyleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  optionButtonSelected: {
    backgroundColor: Colors.light.secondary,
    borderColor: Colors.light.secondary,
  },
  optionText: {
    fontSize: 14,
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.text,
    textAlign: 'center',
  },
  optionTextSelected: {
    color: '#FFFFFF',
    fontFamily: 'Quicksand_600SemiBold',
  },
  genderButton: {
    flex: 1,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  lengthButton: {
    flex: 1,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  lengthPages: {
    fontSize: 12,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.textLight,
    marginTop: 4,
  },
  artStyleButton: {
    width: '31%',
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  createButton: {
    backgroundColor: Colors.light.primary,
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
    marginTop: 32,
  },
  createButtonText: {
    color: Colors.light.textOnPrimary,
    fontSize: 18,
    fontFamily: 'Nunito_700Bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    backgroundColor: Colors.light.background,
  },
  loadingTitle: {
    fontSize: 24,
    fontFamily: 'Baloo2_700Bold',
    color: Colors.light.accent,
    marginTop: 24,
    textAlign: 'center',
  },
  loadingSubtitle: {
    fontSize: 16,
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.textSecondary,
    marginTop: 12,
    textAlign: 'center',
    lineHeight: 24,
  },
  loadingHint: {
    fontSize: 14,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.textLight,
    marginTop: 24,
  },
});
