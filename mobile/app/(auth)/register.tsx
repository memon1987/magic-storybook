import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
} from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../contexts/ThemeContext';
import { GradientBackground } from '../../components/GradientBackground';
import { SectionCard } from '../../components/SectionCard';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { SocialAuthButtons } from '../../components/SocialAuthButtons';
import { ResponsiveContainer } from '../../components/ResponsiveContainer';
import { useResponsive } from '../../hooks/useResponsive';

// FC-027: base type/size values scaled on tablet. Named so the StyleSheet
// base and the `* scale` inline overrides share one number (no silent desync).
const ICON_CIRCLE_SIZE = 96;
const ICON_GLYPH_SIZE = 40;
const TITLE_SIZE = 30;

export default function RegisterScreen() {
  const { palette } = useTheme();
  const { scale } = useResponsive();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);
  const { signup } = useAuth();

  const handleRegister = async () => {
    if (!name || !email || !password || !confirmPassword) {
      Alert.alert('Missing info', 'Please fill in every field.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Passwords don’t match', 'Make sure both password fields match.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Password too short', 'Use at least 6 characters.');
      return;
    }

    setIsLoading(true);
    try {
      await signup(email, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      Alert.alert('Registration failed', message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <ResponsiveContainer padding={24} style={styles.container}>
          <View
            style={[
              styles.iconCircle,
              {
                backgroundColor: palette.colors.primary,
                width: ICON_CIRCLE_SIZE * scale,
                height: ICON_CIRCLE_SIZE * scale,
                borderRadius: (ICON_CIRCLE_SIZE / 2) * scale,
              },
            ]}
          >
            <Ionicons name="sparkles" size={ICON_GLYPH_SIZE * scale} color={palette.colors.textDark} />
          </View>

          <Text
            style={[styles.title, { color: palette.colors.textDark, fontSize: TITLE_SIZE * scale }]}
          >
            Create your account
          </Text>
          <Text style={[styles.subtitle, { color: palette.colors.textMuted }]}>
            Start crafting magical stories today.
          </Text>

          <SectionCard style={styles.card}>
            <Text style={[styles.label, { color: palette.colors.textDark }]}>Your name</Text>
            <TextInput
              style={[styles.input, { color: palette.colors.textDark, backgroundColor: palette.colors.background }]}
              placeholder="Parent or guardian name"
              placeholderTextColor={palette.colors.textMuted}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoComplete="name"
              editable={!isLoading}
            />

            <Text style={[styles.label, { color: palette.colors.textDark }]}>Email</Text>
            <TextInput
              style={[styles.input, { color: palette.colors.textDark, backgroundColor: palette.colors.background }]}
              placeholder="you@example.com"
              placeholderTextColor={palette.colors.textMuted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              editable={!isLoading}
            />

            <Text style={[styles.label, { color: palette.colors.textDark }]}>Password</Text>
            <TextInput
              style={[styles.input, { color: palette.colors.textDark, backgroundColor: palette.colors.background }]}
              placeholder="At least 6 characters"
              placeholderTextColor={palette.colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              editable={!isLoading}
            />

            <Text style={[styles.label, { color: palette.colors.textDark }]}>Confirm password</Text>
            <TextInput
              style={[styles.input, { color: palette.colors.textDark, backgroundColor: palette.colors.background }]}
              placeholder="Re-enter your password"
              placeholderTextColor={palette.colors.textMuted}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoComplete="new-password"
              editable={!isLoading}
            />

            <AnimatedPressable
              onPress={handleRegister}
              disabled={isLoading || socialBusy}
              style={[
                styles.primaryButton,
                { backgroundColor: palette.colors.accent, opacity: isLoading || socialBusy ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.primaryButtonText, { color: '#FFFFFF' }]}>
                {isLoading ? 'Creating account…' : 'Create Account'}
              </Text>
            </AnimatedPressable>

            <SocialAuthButtons parentBusy={isLoading} onBusyChange={setSocialBusy} />
          </SectionCard>

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: palette.colors.textMuted }]}>
              Already have an account?{' '}
            </Text>
            <Link href="/(auth)/login" asChild>
              <AnimatedPressable>
                <Text style={[styles.linkText, { color: palette.colors.accent }]}>Sign In</Text>
              </AnimatedPressable>
            </Link>
          </View>
          </ResponsiveContainer>
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 40,
    alignItems: 'center',
  },
  // FC-027: ResponsiveContainer owns the 24pt horizontal padding (moved off
  // `scroll`) and centers its children — preserves the phone `alignItems`.
  container: {
    alignItems: 'center',
  },
  iconCircle: {
    width: ICON_CIRCLE_SIZE,
    height: ICON_CIRCLE_SIZE,
    borderRadius: ICON_CIRCLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  title: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: TITLE_SIZE,
    marginBottom: 6,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 15,
    marginBottom: 28,
    textAlign: 'center',
  },
  card: {
    width: '100%',
    gap: 4,
  },
  label: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 13,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    borderRadius: 16,
    height: 56,
    paddingHorizontal: 16,
    fontFamily: 'Quicksand_500Medium',
    fontSize: 15,
    marginBottom: 4,
  },
  primaryButton: {
    height: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  primaryButtonText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 16,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  footerText: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
  },
  linkText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 14,
  },
});
