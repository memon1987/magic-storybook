import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { GradientBackground } from './GradientBackground';
import { ProgressBar } from './ProgressBar';
import { useTheme } from '../contexts/ThemeContext';

const SPARKLE_COUNT = 6;
const PARTICLE_COUNT = 20;

interface SplashScreenAnimatedProps {
  progress?: number;
  loadingText?: string;
}

export function SplashScreenAnimated({
  progress = 0.6,
  loadingText = 'Conjuring your story…',
}: SplashScreenAnimatedProps) {
  const { palette } = useTheme();
  const { width, height } = useWindowDimensions();

  const bookBounce = useSharedValue(0);
  const bookRotate = useSharedValue(0);
  const orbit = useSharedValue(0);
  const textPulse = useSharedValue(1);

  useEffect(() => {
    bookBounce.value = withRepeat(
      withSequence(
        withTiming(-12, { duration: 700, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: 700, easing: Easing.in(Easing.cubic) })
      ),
      -1,
      false
    );
    bookRotate.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 1200, easing: Easing.inOut(Easing.cubic) }),
        withTiming(8, { duration: 1200, easing: Easing.inOut(Easing.cubic) })
      ),
      -1,
      true
    );
    orbit.value = withRepeat(withTiming(1, { duration: 6000, easing: Easing.linear }), -1, false);
    textPulse.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: 800, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      true
    );
  }, [bookBounce, bookRotate, orbit, textPulse]);

  const bookStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: bookBounce.value },
      { rotate: `${bookRotate.value}deg` },
    ],
  }));

  const textPulseStyle = useAnimatedStyle(() => ({ opacity: textPulse.value }));

  const sparkles = useMemo(
    () => Array.from({ length: SPARKLE_COUNT }, (_, i) => i),
    []
  );
  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, () => ({
        left: Math.random() * width,
        top: Math.random() * height,
        size: 3 + Math.random() * 5,
        delay: Math.random() * 2000,
        duration: 3000 + Math.random() * 2000,
      })),
    [width, height]
  );

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.secondary]}>
      <View style={styles.particleLayer} pointerEvents="none">
        {particles.map((p, i) => (
          <FloatingParticle key={i} {...p} color={palette.colors.accent} />
        ))}
      </View>

      <View style={styles.center}>
        <View style={styles.bookWrap}>
          <Animated.View style={[styles.bookIcon, bookStyle]}>
            <Ionicons name="book" size={96} color={palette.colors.accent} />
          </Animated.View>
          {sparkles.map((i) => (
            <OrbitingSparkle
              key={i}
              orbit={orbit}
              indexInOrbit={i}
              total={SPARKLE_COUNT}
              radius={84}
              color={palette.colors.primary}
            />
          ))}
        </View>

        <Text style={[styles.title, { color: palette.colors.textDark }]}>AI Storybook</Text>
        <Text style={[styles.tagline, { color: palette.colors.textMuted }]}>
          Magical bedtime stories, made just for you
        </Text>

        <View style={styles.progressWrap}>
          <ProgressBar
            progress={progress}
            trackColor={`${palette.colors.textMuted}33`}
            fillColor={palette.colors.accent}
            height={6}
          />
        </View>

        <Animated.Text
          style={[styles.loadingText, { color: palette.colors.textMuted }, textPulseStyle]}
        >
          {loadingText}
        </Animated.Text>
      </View>
    </GradientBackground>
  );
}

interface OrbitingSparkleProps {
  orbit: SharedValue<number>;
  indexInOrbit: number;
  total: number;
  radius: number;
  color: string;
}

function OrbitingSparkle({ orbit, indexInOrbit, total, radius, color }: OrbitingSparkleProps) {
  const baseAngle = (indexInOrbit / total) * Math.PI * 2;
  const animatedStyle = useAnimatedStyle(() => {
    const angle = baseAngle + orbit.value * Math.PI * 2;
    return {
      transform: [
        { translateX: Math.cos(angle) * radius },
        { translateY: Math.sin(angle) * radius },
      ],
    };
  });
  return (
    <Animated.View style={[styles.sparkle, animatedStyle]}>
      <Ionicons name="sparkles" size={14} color={color} />
    </Animated.View>
  );
}

interface FloatingParticleProps {
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  color: string;
}

function FloatingParticle({ left, top, size, delay, duration, color }: FloatingParticleProps) {
  const offset = useSharedValue(0);
  useEffect(() => {
    offset.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-20, { duration: duration / 2, easing: Easing.inOut(Easing.quad) }),
          withTiming(0, { duration: duration / 2, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    );
  }, [offset, delay, duration]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
    opacity: 0.5,
  }));
  return (
    <Animated.View
      style={[
        style,
        {
          position: 'absolute',
          left,
          top,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  particleLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  bookWrap: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  bookIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparkle: {
    position: 'absolute',
  },
  title: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 36,
    marginBottom: 8,
  },
  tagline: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 32,
  },
  progressWrap: {
    width: '70%',
    marginBottom: 16,
  },
  loadingText: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
  },
});
