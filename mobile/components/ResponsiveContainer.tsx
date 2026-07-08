import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useResponsive } from '../hooks/useResponsive';

/**
 * FC-027: centers its children and caps the *content box* at
 * `contentMaxWidth` (560pt) so forms / settings sections / wizard steps read
 * well on iPad instead of stretching edge-to-edge. On phones the max never
 * binds (available width < ~608), so layout is pixel-identical to before.
 *
 * The container also owns the screen's horizontal padding via the `padding`
 * prop. Host screens **move** their existing `paddingHorizontal` here — never
 * keep both, or padding doubles. `maxWidth = contentMaxWidth + padding*2`
 * keeps the inner content box at exactly 560 while the padding lives outside
 * it, so the visible measure is the same on phone and tablet.
 */
export function ResponsiveContainer({
  children,
  padding = 0,
  style,
}: {
  children: React.ReactNode;
  padding?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { contentMaxWidth } = useResponsive();
  return (
    <View
      style={[
        {
          width: '100%',
          maxWidth: contentMaxWidth + padding * 2,
          alignSelf: 'center',
          paddingHorizontal: padding,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
