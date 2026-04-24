import React from 'react';
import { StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

interface GradientBackgroundProps {
  colors: [string, string, ...string[]];
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
}

export function GradientBackground({
  colors,
  children,
  style,
  start = { x: 0, y: 0 },
  end = { x: 0, y: 1 },
}: GradientBackgroundProps) {
  return (
    <LinearGradient colors={colors} start={start} end={end} style={[styles.fill, style]}>
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
