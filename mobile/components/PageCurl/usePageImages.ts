import { useImage } from '@shopify/react-native-skia';
import { StoryPage } from '../../services/api';

export interface LoadedPages {
  prev: ReturnType<typeof useImage>;
  current: ReturnType<typeof useImage>;
  next: ReturnType<typeof useImage>;
}

export function usePageImages(pages: StoryPage[], currentIndex: number): LoadedPages {
  const prevUrl =
    currentIndex > 0 && pages[currentIndex - 1] ? pages[currentIndex - 1].imageUrl : null;
  const currentUrl = pages[currentIndex]?.imageUrl ?? null;
  const nextUrl =
    currentIndex < pages.length - 1 && pages[currentIndex + 1]
      ? pages[currentIndex + 1].imageUrl
      : null;

  const prev = useImage(prevUrl);
  const current = useImage(currentUrl);
  const next = useImage(nextUrl);

  return { prev, current, next };
}
