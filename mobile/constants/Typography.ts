/**
 * AI Storybook App - Typography (V2 Guide)
 * Custom fonts: Nunito, Quicksand, Baloo 2
 */
export const Typography = {
  fonts: {
    heading: 'Nunito',        // Headers and titles
    body: 'Quicksand',        // Body text, descriptions
    display: 'Baloo2',        // Fun/display text, buttons
  },
  sizes: {
    displayLarge: 32,
    displayMedium: 28,
    headingLarge: 24,
    headingMedium: 20,
    headingSmall: 18,
    bodyLarge: 16,
    bodyMedium: 14,
    bodySmall: 12,
    caption: 11,
  },
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semiBold: '600' as const,
    bold: '700' as const,
    extraBold: '800' as const,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
};

export default Typography;
