import { useEffect } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';

interface Options {
  delay?: number;
  duration?: number;
  translateY?: number;
}

export function useAnimatedEntrance({
  delay = 0,
  duration = 400,
  translateY = 20,
}: Options = {}) {
  const opacity = useSharedValue(0);
  const offsetY = useSharedValue(translateY);

  useEffect(() => {
    const timing = { duration, easing: Easing.out(Easing.cubic) };
    opacity.value = withDelay(delay, withTiming(1, timing));
    offsetY.value = withDelay(delay, withTiming(0, timing));
  }, [delay, duration, opacity, offsetY]);

  return useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: offsetY.value }],
  }));
}
