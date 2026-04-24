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

export default function LoginScreen() {
  const { palette } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Missing info', 'Please enter your email and password.');
      return;
    }
    setIsLoading(true);
    try {
      await login(email, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      Alert.alert('Login failed', message);
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
          <View style={[styles.iconCircle, { backgroundColor: palette.colors.primary }]}>
            <Ionicons name="book" size={44} color={palette.colors.textDark} />
          </View>

          <Text style={[styles.title, { color: palette.colors.textDark }]}>Welcome back!</Text>
          <Text style={[styles.subtitle, { color: palette.colors.textMuted }]}>
            Sign in to keep the magic going.
          </Text>

          <SectionCard style={styles.card}>
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
              placeholder="Your password"
              placeholderTextColor={palette.colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              editable={!isLoading}
            />

            <AnimatedPressable
              onPress={handleLogin}
              disabled={isLoading}
              style={[
                styles.primaryButton,
                { backgroundColor: palette.colors.accent, opacity: isLoading ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.primaryButtonText, { color: '#FFFFFF' }]}>
                {isLoading ? 'Signing in…' : 'Sign In'}
              </Text>
            </AnimatedPressable>

            <View style={styles.dividerRow}>
              <View style={[styles.divider, { backgroundColor: `${palette.colors.textMuted}33` }]} />
              <Text style={[styles.dividerText, { color: palette.colors.textMuted }]}>
                Or continue with
              </Text>
              <View style={[styles.divider, { backgroundColor: `${palette.colors.textMuted}33` }]} />
            </View>

            <AnimatedPressable
              onPress={() => Alert.alert('Coming soon', 'Google sign-in is on the way!')}
              style={[styles.googleButton, { borderColor: `${palette.colors.textMuted}55` }]}
            >
              <Ionicons name="logo-google" size={18} color={palette.colors.textDark} />
              <Text style={[styles.googleButtonText, { color: palette.colors.textDark }]}>
                Continue with Google
              </Text>
            </AnimatedPressable>
          </SectionCard>

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: palette.colors.textMuted }]}>
              Don't have an account?{' '}
            </Text>
            <Link href="/(auth)/register" asChild>
              <AnimatedPressable>
                <Text style={[styles.linkText, { color: palette.colors.accent }]}>Sign Up</Text>
              </AnimatedPressable>
            </Link>
          </View>
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
    paddingHorizontal: 24,
    paddingVertical: 40,
    alignItems: 'center',
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
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
    fontSize: 32,
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
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 18,
  },
  divider: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 12,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 52,
    borderRadius: 999,
    borderWidth: 1,
  },
  googleButtonText: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 15,
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
