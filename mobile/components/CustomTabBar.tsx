import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '../contexts/ThemeContext';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface TabConfig {
  routeName: string;
  label: string;
  icon: IconName;
  iconActive: IconName;
  elevated?: boolean;
}

const TAB_CONFIG: TabConfig[] = [
  { routeName: 'index', label: 'Library', icon: 'library-outline', iconActive: 'library' },
  { routeName: 'create', label: 'Create', icon: 'add-circle', iconActive: 'add-circle', elevated: true },
  { routeName: 'settings', label: 'Settings', icon: 'settings-outline', iconActive: 'settings' },
];

const PILL_WIDTH = 32;
const PILL_HEIGHT = 4;

export function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const [barWidth, setBarWidth] = useState(screenWidth);

  const tabWidth = barWidth / state.routes.length;
  const indicatorX = useSharedValue(state.index * tabWidth + tabWidth / 2 - PILL_WIDTH / 2);

  useEffect(() => {
    indicatorX.value = withSpring(
      state.index * tabWidth + tabWidth / 2 - PILL_WIDTH / 2,
      { damping: 18, stiffness: 220 }
    );
  }, [state.index, tabWidth, indicatorX]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
  }));

  return (
    <View
      onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
      style={[
        styles.bar,
        {
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      <Animated.View
        style={[
          styles.indicator,
          { backgroundColor: palette.colors.accent, top: 6 },
          indicatorStyle,
        ]}
      />

      {state.routes.map((route, index) => {
        const config =
          TAB_CONFIG.find((t) => t.routeName === route.name) ?? {
            routeName: route.name,
            label: route.name,
            icon: 'ellipse-outline' as IconName,
            iconActive: 'ellipse' as IconName,
          };
        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        if (config.elevated) {
          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              onPress={onPress}
              onLongPress={onLongPress}
              style={styles.tab}
            >
              <View
                style={[
                  styles.elevatedCircle,
                  {
                    backgroundColor: palette.colors.primary,
                    shadowColor: palette.colors.primary,
                  },
                ]}
              >
                <Ionicons name={config.iconActive} size={36} color={palette.colors.textDark} />
              </View>
              <Text
                style={[
                  styles.label,
                  { color: isFocused ? palette.colors.textDark : palette.colors.textMuted },
                ]}
              >
                {config.label}
              </Text>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            onPress={onPress}
            onLongPress={onLongPress}
            style={styles.tab}
          >
            <Ionicons
              name={isFocused ? config.iconActive : config.icon}
              size={24}
              color={isFocused ? palette.colors.accent : palette.colors.textMuted}
            />
            <Text
              style={[
                styles.label,
                { color: isFocused ? palette.colors.accent : palette.colors.textMuted },
              ]}
            >
              {config.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.06)',
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  label: {
    fontFamily: 'Quicksand_600SemiBold',
    fontSize: 11,
  },
  indicator: {
    position: 'absolute',
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
    left: 0,
  },
  elevatedCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -24,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
