import { Story } from '../services/api';

/**
 * FC-039: the human-readable title used in the delete-confirm Alert and the
 * delete-badge accessibility label. Stories may have no `title` until
 * generation completes (FC-017), and the title may be whitespace-only, so we
 * fall back to a child-name form. Pure + null-safe so it can be unit-tested
 * and reused by both the badge label and the confirm dialog without drift.
 */
export function deleteDisplayTitle(
  story: Pick<Story, 'title' | 'childName'>
): string {
  const trimmed = story.title?.trim();
  if (trimmed) return trimmed;
  return `Story for ${story.childName}`;
}
