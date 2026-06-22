// Pure paging helpers for the storybook reader.
//
// The reader can prepend a synthetic cover (page 0, FC-012) and append a
// synthetic "The End" page (FC-022). Both are client-only pages that must be
// excluded from the human-facing page count and labeled specially. Keeping
// this logic pure (no React / RN imports) makes it unit-testable in isolation.

export interface PageLabelArgs {
  /** 0-based current page index, including any synthetic cover / end pages. */
  index: number;
  /** Total page count including any synthetic cover + end pages. */
  pageCount: number;
  /** Whether a synthetic cover occupies index 0. */
  hasCover: boolean;
  /** Whether a synthetic "The End" page occupies the final index. */
  hasEndPage: boolean;
}

/**
 * Label shown in the reader's bottom bar for the current page.
 * - Cover page  → "Cover"
 * - End page    → "The End"
 * - Content     → "<n> / <total content pages>" (1-based, cover/end excluded)
 */
export function readerPageLabel({
  index,
  pageCount,
  hasCover,
  hasEndPage,
}: PageLabelArgs): string {
  if (hasEndPage && index === pageCount - 1) return 'The End';
  if (hasCover && index === 0) return 'Cover';

  const coverCount = hasCover ? 1 : 0;
  const storyPageCount = pageCount - coverCount - (hasEndPage ? 1 : 0);
  // index - coverCount + 1 → 1-based position within the content pages.
  return `${index - coverCount + 1} / ${storyPageCount}`;
}
