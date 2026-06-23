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

// Generated story page
export interface StoryPage {
  pageNumber: number;
  text: string;
  sceneDescription: string;
  // FC-020: baked-text illustration guidance (the FC-015 Skia overlay + its
  // textPosition were removed). soundEffects render as stylized onomatopoeia
  // IN the image; emphasizedWords (a subset of `text`) are accented in the
  // baked narration.
  soundEffects?: string[];      // 0-2 short single onomatopoeia words rendered IN the image
  emphasizedWords?: string[];   // subset of `text`; baked larger/accented
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

// FC-017 Phase 2: per-stage progress for live UX + resume.
// `phase` advances monotonically through the pipeline; `completedSteps` is
// scoped to the current phase (e.g. 3 of 6 char-refs done within 'char-refs').
// `message` is backend-rendered user-facing copy so the mobile reader is a
// dumb subscriber.
export type GenerationPhase =
  | 'story-text'
  | 'char-refs'
  | 'cast'
  | 'title'
  | 'anchor-pages'
  | 'parallel-pages'
  | 'finalizing';

export interface GenerationProgress {
  phase: GenerationPhase;
  completedSteps: number;
  totalSteps: number;
  message: string;
  updatedAt: FirebaseFirestore.Timestamp;
}

// FC-017 Phase 2: per-page tracking on the story doc. Lives alongside (not
// instead of) the pages subcollection — the subcollection is the final
// indexed form populated at story completion; this map is the *intermediate*
// resume state: which page URLs have already been generated and uploaded, so
// a resumed worker can skip them.
export interface PageGenerationRecord {
  url: string;
  ocrPassed: boolean;
  attempts: number;
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

  // FC-017 Phase 2: 'queued' is the initial state after the route accepts the
  // request and before a worker has claimed the job. 'generating' is held by
  // an active worker. 'complete' / 'failed' are terminal.
  status: 'queued' | 'generating' | 'complete' | 'failed';
  pageCount?: number;
  characterReferenceUrls?: Record<string, string>;  // FC-013 (per-character model sheets)
  characterSheets?: CharacterVisualSheet[];         // FC-019/020: textual character identities
  settingIdentity?: SettingVisualIdentity;          // FC-019/020: textual setting identity
  titlePage?: TitlePage;                            // FC-012
  titlePageImageUrl?: string;                       // FC-012 (Cloud Storage URL)
  castReferenceUrl?: string;                        // FC-020 (cast lineup ref; >1 character)

  // FC-017 Phase 2 — the resume payload. Persisted incrementally as each
  // phase boundary lands, so a crashed worker can be resumed by reading this
  // doc and skipping what's already done. All optional because they fill in
  // over the course of a run; absent fields mean "not yet generated".
  storyText?: GeneratedStory;                       // populated after story-text phase
  pageUrls?: Record<string, PageGenerationRecord>;  // key = pageNumber as string (Firestore keys must be strings)
  progress?: GenerationProgress;                    // live progress for mobile snapshot subscription

  // FC-017 Phase 2 worker-claim state. Single-writer invariant: a worker only
  // proceeds if it can transactionally claim workerId and refresh
  // workerHeartbeatAt. Stale heartbeat (> 90s) means the lock is up for grabs.
  workerId?: string;
  workerHeartbeatAt?: FirebaseFirestore.Timestamp;
  attempt?: number;                                 // resume counter (1, 2, ...)
  failureReason?: FailureCode;                      // FC-025 H-1: bounded enum, not raw error message

  // FC-025 B-6: distinguish "never attempted" from "attempted and failed".
  // Without these, a prior-run failure persisted as castReferenceUrl=null
  // looked indistinguishable from "not yet tried" and was retried forever.
  castAttempted?: boolean;
  titleAttempted?: boolean;

  createdAt: FirebaseFirestore.Timestamp;
}

/**
 * FC-025 H-1: bounded set of failure codes that may be surfaced to the
 * mobile client via the failureReason field. Raw upstream Error.message
 * strings are logged server-side only, never persisted here.
 */
export type FailureCode =
  | 'generation_error'
  | 'network_error'
  | 'quota_exceeded'
  | 'safety_blocked'
  | 'sigterm'
  | 'unknown';

// Page document in Firestore (subcollection)
export interface PageDocument {
  id: string;
  pageNumber: number;
  text: string;
  sceneDescription: string;
  imageUrl: string;
  // FC-020: baked-text illustration guidance (textPosition removed with the overlay)
  soundEffects?: string[];
  emphasizedWords?: string[];
}
