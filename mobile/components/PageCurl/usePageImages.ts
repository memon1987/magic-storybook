import { useImage } from '@shopify/react-native-skia';
import { StoryPage } from '../../services/api';

export interface LoadedPages {
  prev: ReturnType<typeof useImage>;
  current: ReturnType<typeof useImage>;
  next: ReturnType<typeof useImage>;
}

export function usePageImages(pages: StoryPage[], currentIndex: number): LoadedPages {
  // `|| null` (not `?? null`) so an empty imageUrl — e.g. the FC-022 synthetic
  // "The End" page, or any malformed page — never reaches Skia's useImage('').
  const prevUrl =
    currentIndex > 0 && pages[currentIndex - 1] ? pages[currentIndex - 1].imageUrl || null : null;
  const currentUrl = pages[currentIndex]?.imageUrl || null;
  const nextUrl =
    currentIndex < pages.length - 1 && pages[currentIndex + 1]
      ? pages[currentIndex + 1].imageUrl || null
      : null;

  const prev = useImage(prevUrl);
  const current = useImage(currentUrl);
  const next = useImage(nextUrl);

  return { prev, current, next };
}
