import React, { useEffect } from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface ProgressBarProps {
  progress: number;
  trackColor: string;
  fillColor: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
  duration?: number;
}

export function ProgressBar({
  progress,
  trackColor,
  fillColor,
  height = 8,
  style,
  duration = 400,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, progress));
  const widthValue = useSharedValue(clamped);

  useEffect(() => {
    widthValue.value = withTiming(clamped, {
      duration,
      easing: Easing.out(Easing.cubic),
    });
  }, [clamped, duration, widthValue]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${widthValue.value * 100}%`,
  }));

  return (
    <View
      style={[
        styles.track,
        { backgroundColor: trackColor, height, borderRadius: height / 2 },
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          { backgroundColor: fillColor, height, borderRadius: height / 2 },
          fillStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
