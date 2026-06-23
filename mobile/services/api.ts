import axios, { AxiosInstance } from 'axios';
import { getIdToken } from './firebase';

const API_URL = process.env.EXPO_PUBLIC_API_URL;
if (!API_URL || /XXXX/.test(API_URL)) {
  throw new Error(
    'EXPO_PUBLIC_API_URL is missing or still set to a placeholder. Copy mobile/.env.example to mobile/.env and populate with the real Cloud Run URL.'
  );
}

// Create axios instance
//
// FC-017 Phase 3: timeout dropped from 600s → 30s. The backend now responds
// 202 immediately to `/generate` and `/:id/resume` (after only the initial
// doc write + sync auth/ownership check, ~100-500ms). Mobile subscribes to
// the Firestore story doc for live progress and terminal status via
// services/stories.ts → subscribeToStory(). The 600s timeout was the
// vector for the silent-success bug: backend kept running past timeout,
// finished, and saved the story — user saw a hard error and the story
// silently appeared on next library refresh.
const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use(async (config) => {
  const token = await getIdToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Types
export type ArtStyle = 'watercolor' | 'cartoon' | 'storybook-classic' | 'claymation' | 'studio-ghibli' | 'pixar-3d';
export type StoryLength = 'short' | 'medium' | 'long';

// FC-014: voices the wizard offers. Generic UI labels — no copyrighted author names.
// WRITING_STYLES is the single source of truth on the mobile side; WritingStyleId is
// derived from it so adding a new entry below auto-extends the type. Backend keeps its
// own WRITING_STYLE_IDS list in `backend/src/prompts/story.ts`; the two must stay in
// sync at the API contract (no automated cross-checking — flag in code review).
export interface WritingStyleOption {
  id: string;
  label: string;
  description: string;
}

export const WRITING_STYLES = [
  { id: 'bouncy-rhymes',   label: 'Bouncy Rhymes',  description: 'Rhyming and energetic' },
  { id: 'gentle-refrains', label: 'Gentle Refrains', description: 'Soft, repeating, sensory' },
  { id: 'sweet-simple',    label: 'Sweet & Simple', description: 'Short lines, big feelings' },
] as const satisfies readonly WritingStyleOption[];

export type WritingStyleId = (typeof WRITING_STYLES)[number]['id'];

export interface StoryInput {
  childName: string;
  childGender?: 'boy' | 'girl';
  favoriteAnimal?: string;
  specialFriendName?: string;
  specialFriendDescription?: string;
  setting: string;
  moral: string;
  authorStyle?: string;            // legacy: free-text; retained for back-compat
  writingStyle?: WritingStyleId;   // FC-014: structured voice picker; takes precedence over authorStyle
  length: StoryLength;
  artStyle?: ArtStyle;
}

export interface StoryPage {
  pageNumber: number;
  text: string;
  imageUrl: string;
  // FC-020: narration is baked into the image. These fields are still returned
  // by the API (baked illustration guidance) but the reader no longer renders
  // anything from them — text is part of the illustration.
  soundEffects?: string[] | null;
  emphasizedWords?: string[] | null;
}

// FC-012: cover/title page data (separate from content pages).
export interface StoryTitlePage {
  text: string;
  sceneDescription: string;
}

// FC-017 Phase 3+4: stories can be in any of these states. The library
// renders distinct affordances per status.
export type StoryStatus = 'queued' | 'generating' | 'complete' | 'failed';

// FC-017 / FC-025 H-1: bounded set of failure codes safe to surface to the
// client. Raw upstream errors never reach this field — server logs only.
// Keep in sync with backend/src/types/index.ts FailureCode.
export type FailureCode =
  | 'generation_error'
  | 'network_error'
  | 'quota_exceeded'
  | 'safety_blocked'
  | 'sigterm'
  | 'orphaned'
  | 'unknown';

// FC-017 Phase 4: per-stage progress for live UX. Backend renders the
// `message` string; mobile is a dumb subscriber. `updatedAt` comes from
// Firestore as a Timestamp or from HTTP-JSON as an ISO string; we don't
// render it.
export interface GenerationProgress {
  phase: 'story-text' | 'char-refs' | 'cast' | 'title' | 'anchor-pages' | 'parallel-pages' | 'finalizing';
  completedSteps: number;
  totalSteps: number;
  message: string;
}

export interface Story {
  id: string;
  title?: string;                    // FC-017: optional — absent until status='complete'
  childName: string;
  childGender?: 'boy' | 'girl';
  favoriteAnimal: string;
  specialFriendName?: string;
  specialFriendDescription?: string;
  setting: string;
  moral: string;
  authorStyle?: string;
  writingStyle?: WritingStyleId;
  artStyle: ArtStyle;
  pageCount?: number;                // FC-017: optional — absent until status='complete'
  pages?: StoryPage[];
  // FC-012: cover image + cover scene description, distinct from content pages.
  // Optional for backwards-compatibility with stories generated pre-FC-012.
  titlePageImageUrl?: string;
  titlePage?: StoryTitlePage;
  // FC-017 Phase 3+4: live state surfaced via list/get and Firestore snapshot.
  status: StoryStatus;
  progress?: GenerationProgress;
  failureReason?: FailureCode;
  createdAt: string;
  // FC-031 Change 6(a): number of times the worker has been claimed on
  // this doc (initial generate counts as 1; each Resume increments).
  // Used by the /generating screen to enforce the retry budget — after
  // 3 attempts on a failed story, Resume is replaced with "Try
  // different inputs" + "Create new story" CTA.
  attempt?: number;
}

// FC-017 Phase 3: POST /generate and POST /:id/resume now return 202 with
// just `{ storyId, status }` — mobile subscribes to the Firestore doc for
// terminal status. The full assembled story arrives via the snapshot (or
// via getStory(id) once status='complete').
export interface AcceptedStoryResponse {
  storyId: string;
  status: StoryStatus;
}

// API Functions

/**
 * FC-017 Phase 3: kick off story generation. Returns immediately with the
 * storyId; the caller should navigate to the generating screen and
 * subscribe via subscribeToStory(storyId) for live progress.
 */
export async function startStoryGeneration(input: StoryInput): Promise<AcceptedStoryResponse> {
  const response = await api.post<AcceptedStoryResponse>('/api/stories/generate', input);
  return response.data;
}

/**
 * FC-017 Phase 3: re-fire the worker for a story whose prior run died
 * mid-flight or was marked failed. Same 202 + subscribe pattern as
 * startStoryGeneration. Backend validates auth + ownership synchronously.
 */
export async function resumeStory(id: string): Promise<AcceptedStoryResponse> {
  const response = await api.post<AcceptedStoryResponse>(`/api/stories/${id}/resume`);
  return response.data;
}

/**
 * Get all stories for the current user
 */
export async function getStories(): Promise<Story[]> {
  const response = await api.get<{ stories: Story[] }>('/api/stories');
  return response.data.stories;
}

/**
 * Get a single story with all pages
 */
export async function getStory(id: string): Promise<Story> {
  const response = await api.get<Story>(`/api/stories/${id}`);
  return response.data;
}

/**
 * Delete a story
 */
export async function deleteStory(id: string): Promise<void> {
  await api.delete(`/api/stories/${id}`);
}

/**
 * Health check
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await api.get('/health');
    return response.data.status === 'healthy';
  } catch {
    return false;
  }
}

export default api;
