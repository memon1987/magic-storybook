import { Request } from 'express';
import admin from 'firebase-admin';

// Extend Express Request with authenticated user
export interface AuthRequest extends Request {
  user?: admin.auth.DecodedIdToken;
}

// Writing-style ids exposed to the client (FC-014)
export type WritingStyleId = 'bouncy-rhymes' | 'gentle-refrains' | 'sweet-simple';

// Story input from client
export interface StoryInput {
  childName: string;
  childGender?: 'boy' | 'girl';
  favoriteAnimal?: string;           // legacy support
  specialFriendName?: string;        // e.g., "Whiskers"
  specialFriendDescription?: string; // e.g., "a fluffy orange cat"
  setting: string;
  moral: string;
  authorStyle?: string;              // legacy: free-text author name; retained for back-compat
  writingStyle?: WritingStyleId;     // FC-014: structured voice picker; takes precedence over authorStyle
  length: 'short' | 'medium' | 'long';
  artStyle?: ArtStyle;
}

// Art styles for illustrations
export type ArtStyle = 'watercolor' | 'cartoon' | 'storybook-classic' | 'claymation' | 'studio-ghibli' | 'pixar-3d';

// FC-015: where narration text lands on the page (composed in the Skia overlay
// on the mobile reader, NOT baked into the image). The illustration prompt
// reserves negative space at the indicated position so the overlay reads cleanly.
// `center-overlay` is reserved for emphatic short lines that sit on top of the
// illustration with a translucent backing rect.
export type TextPosition = 'top' | 'bottom' | 'left' | 'right' | 'center-overlay';

export const TEXT_POSITIONS: readonly TextPosition[] = [
  'top',
  'bottom',
  'left',
  'right',
  'center-overlay',
] as const;

// Generated story page
export interface StoryPage {
  pageNumber: number;
  text: string;
  sceneDescription: string;
  // FC-015: optional fields. Older stories generated before FC-015 won't have
  // these; the mobile reader treats their absence as "no overlay — text is
  // baked into the image" (legacy render path).
  textPosition?: TextPosition;
  soundEffects?: string[];      // 0-2 short single onomatopoeia words rendered IN the image
  emphasizedWords?: string[];   // subset of `text`; rendered larger/accented in the overlay
}

// FC-012: title page (cover) — distinct from content pages.
// `text` is the on-cover display text (book title, optionally "Starring X").
// `sceneDescription` is what the illustrator generates as the cover scene.
export interface TitlePage {
  text: string;
  sceneDescription: string;
}

// Character visual reference for cross-page consistency
export interface CharacterVisualSheet {
  name: string;
  description: string;
}

// Setting visual reference for cross-page consistency
export interface SettingVisualIdentity {
  name: string;
  description: string;
}

// Complete generated story
export interface GeneratedStory {
  title: string;
  characterSheets: CharacterVisualSheet[];
  settingIdentity: SettingVisualIdentity;
  pages: StoryPage[];
  // FC-012: cover page produced alongside the story (text + scene). Image URL
  // is populated separately by generateAllIllustrations and surfaced as
  // titlePageImageUrl on the story document, NOT inside pages[].
  titlePage?: TitlePage;
  // FC-013: per-character reference image URLs (key = character name, value = Cloud Storage public URL).
  // Populated by generateAllIllustrations after the new pipeline runs.
  characterReferenceUrls?: Record<string, string>;
}

// Story page with image URL (after illustration generation)
export interface StoryPageWithImage extends StoryPage {
  imageUrl: string;
}

// Story document in Firestore
export interface StoryDocument {
  id: string;
  userId: string;
  title: string;
  childName: string;
  childGender?: 'boy' | 'girl';
  favoriteAnimal: string;
  specialFriendName?: string;
  specialFriendDescription?: string;
  setting: string;
  moral: string;
  authorStyle?: string;
  writingStyle?: WritingStyleId;
  length: 'short' | 'medium' | 'long';
  artStyle: ArtStyle;
  status: 'pending' | 'generating' | 'complete' | 'failed';
  pageCount?: number;
  characterReferenceUrls?: Record<string, string>;  // FC-013
  characterSheets?: CharacterVisualSheet[];         // FC-019: persisted for spike route reload
  settingIdentity?: SettingVisualIdentity;          // FC-019: persisted for spike route reload
  titlePage?: TitlePage;                            // FC-012
  titlePageImageUrl?: string;                       // FC-012 (Cloud Storage URL)
  createdAt: FirebaseFirestore.Timestamp;
}

// Page document in Firestore (subcollection)
export interface PageDocument {
  id: string;
  pageNumber: number;
  text: string;
  sceneDescription: string;
  imageUrl: string;
  // FC-015: optional overlay metadata
  textPosition?: TextPosition;
  soundEffects?: string[];
  emphasizedWords?: string[];
}
