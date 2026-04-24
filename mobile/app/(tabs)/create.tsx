import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Animated, {
  SlideInRight,
  SlideOutLeft,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { generateStory, ArtStyle, StoryLength, StoryInput } from '../../services/api';
import { useTheme } from '../../contexts/ThemeContext';
import { GradientBackground } from '../../components/GradientBackground';
import { ProgressBar } from '../../components/ProgressBar';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ANIMAL_SUGGESTIONS = [
  'Bunny', 'Bear', 'Fox', 'Owl', 'Penguin', 'Lion', 'Elephant', 'Dolphin', 'Dragon', 'Unicorn',
];

const SETTING_SUGGESTIONS = [
  'Enchanted Forest', 'Outer Space', 'Underwater Kingdom', 'Magical Castle',
  'Cozy Village', 'Dinosaur Land', 'Snowy Mountain', 'Candy World',
];

const MORAL_SUGGESTIONS = [
  'Kindness', 'Bravery', 'Sharing', 'Honesty', 'Friendship', 'Perseverance',
];

interface LengthOption {
  value: StoryLength;
  label: string;
  pages: string;
  time: string;
}

const LENGTH_OPTIONS: LengthOption[] = [
  { value: 'short', label: 'Short', pages: '4 pages', time: '~5 min read' },
  { value: 'medium', label: 'Medium', pages: '6 pages', time: '~8 min read' },
  { value: 'long', label: 'Long', pages: '8 pages', time: '~12 min read' },
];

interface ArtStyleOption {
  value: ArtStyle;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}

const ART_STYLE_OPTIONS: ArtStyleOption[] = [
  { value: 'watercolor', label: 'Watercolor', icon: 'water-outline' },
  { value: 'cartoon', label: 'Cartoon', icon: 'happy-outline' },
  { value: 'storybook-classic', label: 'Classic', icon: 'book-outline' },
  { value: 'claymation', label: 'Claymation', icon: 'cube-outline' },
  { value: 'studio-ghibli', label: 'Ghibli', icon: 'leaf-outline' },
  { value: 'pixar-3d', label: 'Pixar 3D', icon: 'star-outline' },
];

const GENERATING_MESSAGES = [
  'Sprinkling some magic dust…',
  'Drawing the illustrations…',
  'Weaving the words together…',
  'Adding the finishing touches…',
];

interface FormData {
  childName: string;
  favoriteAnimal: string;
  setting: string;
  moral: string;
  length: StoryLength;
  artStyle: ArtStyle;
}

const TOTAL_STEPS = 6;

const INITIAL_FORM: FormData = {
  childName: '',
  favoriteAnimal: '',
  setting: '',
  moral: '',
  length: 'medium',
  artStyle: 'watercolor',
};

export default function CreateScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();

  const [stepIndex, setStepIndex] = useState(0);
  const [formData, setFormData] = useState<FormData>(INITIAL_FORM);

  const mutation = useMutation({
    mutationFn: (input: StoryInput) => generateStory(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
      router.replace(`/story/${data.id}/read`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to generate story';
      Alert.alert('Generation failed', message);
    },
  });

  const update = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setFormData((prev) => ({ ...prev, [key]: value }));

  const canContinue = useMemo(() => {
    switch (stepIndex) {
      case 0:
        return formData.childName.trim().length > 0;
      case 1:
        return formData.favoriteAnimal.trim().length > 0;
      case 2:
        return formData.setting.trim().length > 0;
      case 3:
        return formData.moral.trim().length > 0;
      case 4:
      case 5:
        return true;
      default:
        return false;
    }
  }, [stepIndex, formData]);

  const handleContinue = () => {
    if (!canContinue) return;
    if (stepIndex < TOTAL_STEPS - 1) {
      setStepIndex((s) => s + 1);
    } else {
      mutation.mutate({
        childName: formData.childName.trim(),
        favoriteAnimal: formData.favoriteAnimal.trim(),
        setting: formData.setting.trim().toLowerCase(),
        moral: formData.moral.trim().toLowerCase(),
        length: formData.length,
        artStyle: formData.artStyle,
      });
    }
  };

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex((s) => s - 1);
  };

  const progress = (stepIndex + 1) / TOTAL_STEPS;

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.cardBg]}>
      <View style={{ height: insets.top }} />

      <View style={styles.headerRow}>
        <Pressable
          onPress={handleBack}
          disabled={stepIndex === 0}
          style={[styles.iconButton, { opacity: stepIndex === 0 ? 0 : 1 }]}
          hitSlop={12}
        >
          <Ionicons name="arrow-back" size={22} color={palette.colors.textDark} />
        </Pressable>
        <View style={styles.progressWrap}>
          <View style={styles.progressMetaRow}>
            <Text style={[styles.stepLabel, { color: palette.colors.textMuted }]}>
              Step {stepIndex + 1} of {TOTAL_STEPS}
            </Text>
            <Text style={[styles.stepLabel, { color: palette.colors.textMuted }]}>
              {Math.round(progress * 100)}%
            </Text>
          </View>
          <ProgressBar
            progress={progress}
            trackColor={`${palette.colors.textMuted}22`}
            fillColor={palette.colors.accent}
            height={6}
          />
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            key={stepIndex}
            entering={SlideInRight.duration(280)}
            exiting={SlideOutLeft.duration(280)}
            style={styles.stepWrap}
          >
            {stepIndex === 0 && (
              <TextStep
                title="What's your child's name?"
                subtitle="We'll make them the hero of the story."
                placeholder="e.g. Maya"
                value={formData.childName}
                onChange={(v) => update('childName', v)}
              />
            )}
            {stepIndex === 1 && (
              <TextStep
                title="What's their favorite animal?"
                subtitle="Pick a buddy to join the adventure."
                placeholder="e.g. Bunny"
                value={formData.favoriteAnimal}
                onChange={(v) => update('favoriteAnimal', v)}
                suggestions={ANIMAL_SUGGESTIONS}
              />
            )}
            {stepIndex === 2 && (
              <TextStep
                title="Where does the story happen?"
                subtitle="Choose any magical setting."
                placeholder="e.g. Enchanted Forest"
                value={formData.setting}
                onChange={(v) => update('setting', v)}
                suggestions={SETTING_SUGGESTIONS}
              />
            )}
            {stepIndex === 3 && (
              <TextStep
                title="What lesson should it teach?"
                subtitle="A simple moral the story will carry."
                placeholder="e.g. Kindness"
                value={formData.moral}
                onChange={(v) => update('moral', v)}
                suggestions={MORAL_SUGGESTIONS}
              />
            )}
            {stepIndex === 4 && (
              <LengthStep
                value={formData.length}
                onChange={(v) => update('length', v)}
              />
            )}
            {stepIndex === 5 && (
              <ArtStyleStep
                value={formData.artStyle}
                onChange={(v) => update('artStyle', v)}
              />
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <AnimatedPressable
          onPress={handleContinue}
          disabled={!canContinue || mutation.isPending}
          style={[
            styles.primaryButton,
            {
              backgroundColor: palette.colors.accent,
              opacity: canContinue && !mutation.isPending ? 1 : 0.5,
            },
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {stepIndex === TOTAL_STEPS - 1 ? 'Create Story' : 'Continue'}
          </Text>
          <Ionicons
            name={stepIndex === TOTAL_STEPS - 1 ? 'sparkles' : 'arrow-forward'}
            size={18}
            color="#FFFFFF"
          />
        </AnimatedPressable>
      </View>

      {mutation.isPending && <GeneratingOverlay />}
    </GradientBackground>
  );
}

interface TextStepProps {
  title: string;
  subtitle: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  suggestions?: string[];
}

function TextStep({ title, subtitle, placeholder, value, onChange, suggestions }: TextStepProps) {
  const { palette } = useTheme();
  return (
    <View style={styles.step}>
      <Text style={[styles.stepTitle, { color: palette.colors.textDark }]}>{title}</Text>
      <Text style={[styles.stepSubtitle, { color: palette.colors.textMuted }]}>{subtitle}</Text>
      <TextInput
        style={[
          styles.bigInput,
          {
            color: palette.colors.textDark,
            backgroundColor: palette.colors.cardBg,
            borderColor: `${palette.colors.textMuted}22`,
          },
        ]}
        placeholder={placeholder}
        placeholderTextColor={palette.colors.textMuted}
        value={value}
        onChangeText={onChange}
        autoFocus
      />
      {suggestions && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {suggestions.map((s) => (
            <AnimatedPressable
              key={s}
              onPress={() => onChange(s)}
              style={[
                styles.chip,
                {
                  backgroundColor:
                    value.toLowerCase() === s.toLowerCase()
                      ? palette.colors.primary
                      : palette.colors.cardBg,
                  borderColor: `${palette.colors.textMuted}22`,
                },
              ]}
            >
              <Text style={[styles.chipText, { color: palette.colors.textDark }]}>{s}</Text>
            </AnimatedPressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

interface LengthStepProps {
  value: StoryLength;
  onChange: (v: StoryLength) => void;
}

function LengthStep({ value, onChange }: LengthStepProps) {
  const { palette } = useTheme();
  return (
    <View style={styles.step}>
      <Text style={[styles.stepTitle, { color: palette.colors.textDark }]}>
        How long should it be?
      </Text>
      <Text style={[styles.stepSubtitle, { color: palette.colors.textMuted }]}>
        Pick the length that fits tonight's bedtime.
      </Text>
      <View style={styles.lengthList}>
        {LENGTH_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <AnimatedPressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[
                styles.lengthCard,
                {
                  backgroundColor: palette.colors.cardBg,
                  borderColor: selected ? palette.colors.accent : `${palette.colors.textMuted}22`,
                  borderWidth: selected ? 2 : 1,
                },
              ]}
            >
              <View style={styles.lengthCardLeft}>
                <Text style={[styles.lengthLabel, { color: palette.colors.textDark }]}>
                  {opt.label}
                </Text>
                <Text style={[styles.lengthMeta, { color: palette.colors.textMuted }]}>
                  {opt.pages} • {opt.time}
                </Text>
              </View>
              {selected && (
                <View style={[styles.checkCircle, { backgroundColor: palette.colors.accent }]}>
                  <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                </View>
              )}
            </AnimatedPressable>
          );
        })}
      </View>
    </View>
  );
}

interface ArtStyleStepProps {
  value: ArtStyle;
  onChange: (v: ArtStyle) => void;
}

function ArtStyleStep({ value, onChange }: ArtStyleStepProps) {
  const { palette } = useTheme();
  return (
    <View style={styles.step}>
      <Text style={[styles.stepTitle, { color: palette.colors.textDark }]}>Pick an art style</Text>
      <Text style={[styles.stepSubtitle, { color: palette.colors.textMuted }]}>
        Each style gives the story a different feel.
      </Text>
      <View style={styles.styleGrid}>
        {ART_STYLE_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <AnimatedPressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[
                styles.styleCard,
                {
                  backgroundColor: palette.colors.cardBg,
                  borderColor: selected ? palette.colors.accent : `${palette.colors.textMuted}22`,
                  borderWidth: selected ? 2 : 1,
                },
              ]}
            >
              <View
                style={[
                  styles.styleIconWrap,
                  { backgroundColor: selected ? palette.colors.primary : palette.colors.background },
                ]}
              >
                <Ionicons name={opt.icon} size={28} color={palette.colors.textDark} />
              </View>
              <Text
                style={[styles.styleLabel, { color: palette.colors.textDark }]}
                numberOfLines={1}
              >
                {opt.label}
              </Text>
            </AnimatedPressable>
          );
        })}
      </View>
    </View>
  );
}

function GeneratingOverlay() {
  const { palette } = useTheme();
  const [messageIndex, setMessageIndex] = useState(0);
  const rotate = useSharedValue(0);
  const [progressTick, setProgressTick] = useState(0.05);

  useEffect(() => {
    rotate.value = withRepeat(
      withTiming(360, { duration: 2400, easing: Easing.linear }),
      -1,
      false
    );
    const id = setInterval(
      () => setMessageIndex((i) => (i + 1) % GENERATING_MESSAGES.length),
      2200
    );
    const progressId = setInterval(() => {
      setProgressTick((p) => p + (0.95 - p) * 0.04);
    }, 1500);
    return () => {
      clearInterval(id);
      clearInterval(progressId);
    };
  }, [rotate]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      style={StyleSheet.absoluteFill}
    >
      <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
        <View style={styles.overlayCenter}>
          <Animated.View style={iconStyle}>
            <Ionicons name="book" size={96} color={palette.colors.accent} />
          </Animated.View>
          <Text style={[styles.overlayTitle, { color: palette.colors.textDark }]}>
            {GENERATING_MESSAGES[messageIndex]}
          </Text>
          <Text style={[styles.overlaySubtitle, { color: palette.colors.textMuted }]}>
            This usually takes about a minute.
          </Text>
          <View style={styles.overlayProgressWrap}>
            <ProgressBar
              progress={progressTick}
              trackColor={`${palette.colors.textMuted}33`}
              fillColor={palette.colors.accent}
              height={6}
              duration={1500}
            />
          </View>
        </View>
      </GradientBackground>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressWrap: {
    flex: 1,
  },
  progressMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  stepLabel: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 12,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  stepWrap: {
    flex: 1,
  },
  step: {
    gap: 12,
  },
  stepTitle: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 26,
    lineHeight: 32,
  },
  stepSubtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    marginBottom: 8,
  },
  bigInput: {
    height: 64,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 18,
  },
  chipRow: {
    gap: 8,
    paddingVertical: 4,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 13,
  },
  lengthList: {
    gap: 12,
    marginTop: 8,
  },
  lengthCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  lengthCardLeft: {
    flex: 1,
  },
  lengthLabel: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 17,
    marginBottom: 2,
  },
  lengthMeta: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
  },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  styleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
  },
  styleCard: {
    width: '31%',
    aspectRatio: 0.85,
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  styleIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  styleLabel: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 13,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 56,
    borderRadius: 999,
  },
  primaryButtonText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  overlayCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  overlayTitle: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 22,
    textAlign: 'center',
    marginTop: 24,
  },
  overlaySubtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    textAlign: 'center',
  },
  overlayProgressWrap: {
    width: '70%',
    marginTop: 12,
  },
});
