import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useResponsive } from '../hooks/useResponsive';

/**
 * FC-027: centers its children and caps the *content box* at
 * `contentMaxWidth` (560pt) so forms / settings sections / wizard steps read
 * well on iPad instead of stretching edge-to-edge.
 *
 * The cap is gated on `deviceClass === 'tablet'` (short-edge ≥ 600), NOT on
 * live window width. This is deliberate: a phone in *landscape* has a window
 * width (its long edge) well above 608, so a width-based cap would bind on
 * phones too and shrink landscape phone layouts — contradicting the plan's
 * "phones render unchanged, both orientations" contract. Gating on the
 * orientation-stable device class keeps every phone (portrait AND landscape)
 * pixel-identical to before, and applies the cap only to iPads.
 *
 * The container also owns the screen's horizontal padding via the `padding`
 * prop. Host screens **move** their existing `paddingHorizontal` here — never
 * keep both, or padding doubles. On tablets `maxWidth = contentMaxWidth +
 * padding*2` keeps the inner content box at exactly 560 while the padding
 * lives outside it; on phones there is no maxWidth, so the box fills the
 * available width exactly as before, with the padding it always had.
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
  const { contentMaxWidth, deviceClass } = useResponsive();
  const capped = deviceClass === 'tablet';
  return (
    <View
      style={[
        {
          width: '100%',
          maxWidth: capped ? contentMaxWidth + padding * 2 : undefined,
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
