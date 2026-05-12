import { useFonts as useSkiaFonts } from '@shopify/react-native-skia';

/**
 * FC-015: register the three writing-style fonts with Skia so the page
 * narration overlay (`PageTextLayer`) can render them inside the canvas.
 *
 * The font family keys here MUST match the values in `WRITING_STYLE_FONT_MAP`
 * (`mobile/services/api.ts`). The TTF files come from the `@expo-google-fonts/*`
 * packages already in package.json — no new font assets in the bundle.
 *
 * Returns the `SkTypefaceFontProvider` (Skia's `FontMgr` for custom fonts) or
 * `null` while loading. Callers should gate Skia text rendering on a non-null
 * return value; if registration fails (typo, asset bundler miss), the reader
 * still shows the illustration — text just doesn't appear in the overlay.
 */
export function useStoryFonts() {
  return useSkiaFonts({
    'Baloo 2': [require('@expo-google-fonts/baloo-2/700Bold/Baloo2_700Bold.ttf')],
    'Nunito': [require('@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf')],
    'Quicksand': [require('@expo-google-fonts/quicksand/600SemiBold/Quicksand_600SemiBold.ttf')],
  });
}
