import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../contexts/ThemeContext';
import { AnimatedPressable } from './AnimatedPressable';

interface SocialAuthButtonsProps {
  /** True while the parent's email/password flow is in-flight, to disable social buttons. */
  parentBusy?: boolean;
  /** Notifies the parent when a social flow starts/stops, so it can disable its own buttons. */
  onBusyChange?: (busy: boolean) => void;
}

// Apple throws this code when the user dismisses the sheet; Google's wrapper
// throws this message (see services/firebase.ts). Both are swallowed silently.
const APPLE_CANCEL_CODE = 'ERR_REQUEST_CANCELED';
const GOOGLE_CANCEL_MESSAGE = 'Google sign-in was cancelled.';

/**
 * Shared "Or continue with" block: Google (all platforms) + Apple (iOS only,
 * required by App Store Guideline 4.8 when offering Google). Rendered on both
 * the login and register screens — Firebase creates the user on first credential
 * sign-in, so one method serves both.
 */
export function SocialAuthButtons({ parentBusy, onBusyChange }: SocialAuthButtonsProps) {
  const { palette } = useTheme();
  const { signInWithGoogle, signInWithApple } = useAuth();
  const [busy, setBusy] = useState<null | 'google' | 'apple'>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync()
        .then((available) => {
          if (active) setAppleAvailable(available);
        })
        .catch(() => {
          if (active) setAppleAvailable(false);
        });
    }
    return () => {
      active = false;
    };
  }, []);

  const isBusy = busy !== null || !!parentBusy;

  const run = async (which: 'google' | 'apple', fn: () => Promise<void>) => {
    setBusy(which);
    onBusyChange?.(true);
    try {
      await fn();
      // On success the root auth-state guard routes away from (auth).
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign-in failed';
      const code = (error as { code?: string })?.code;
      const cancelled = code === APPLE_CANCEL_CODE || message === GOOGLE_CANCEL_MESSAGE;
      if (!cancelled) {
        Alert.alert('Sign-in failed', message);
      }
    } finally {
      setBusy(null);
      onBusyChange?.(false);
    }
  };

  return (
    <View>
      <View style={styles.dividerRow}>
        <View style={[styles.divider, { backgroundColor: `${palette.colors.textMuted}33` }]} />
        <Text style={[styles.dividerText, { color: palette.colors.textMuted }]}>
          Or continue with
        </Text>
        <View style={[styles.divider, { backgroundColor: `${palette.colors.textMuted}33` }]} />
      </View>

      <AnimatedPressable
        onPress={() => run('google', signInWithGoogle)}
        disabled={isBusy}
        style={[
          styles.googleButton,
          { borderColor: `${palette.colors.textMuted}55`, opacity: isBusy ? 0.6 : 1 },
        ]}
      >
        <Ionicons name="logo-google" size={18} color={palette.colors.textDark} />
        <Text style={[styles.googleButtonText, { color: palette.colors.textDark }]}>
          {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
        </Text>
      </AnimatedPressable>

      {appleAvailable && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={26}
          style={[styles.appleButton, { opacity: isBusy ? 0.6 : 1 }]}
          onPress={() => {
            if (!isBusy) run('apple', signInWithApple);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  appleButton: {
    height: 52,
    width: '100%',
    marginTop: 12,
  },
});
