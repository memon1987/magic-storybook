import axios, { AxiosInstance } from 'axios';
import { getIdToken } from './firebase';

const API_URL = process.env.EXPO_PUBLIC_API_URL;
if (!API_URL || /XXXX/.test(API_URL)) {
  throw new Error(
    'EXPO_PUBLIC_API_URL is missing or still set to a placeholder. Copy mobile/.env.example to mobile/.env and populate with the real Cloud Run URL.'
  );
}

// Create axios instance
const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 600000, // 10 minutes — story + 4-12 illustrations + 503 retries (Cloud Run timeout is 600s)
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
export type WritingStyleId = 'bouncy-rhymes' | 'gentle-refrains' | 'sweet-simple';

export interface WritingStyleOption {
  id: WritingStyleId;
  label: string;
  description: string;
}

// FC-014: voices the wizard offers. Generic UI labels — no copyrighted author names.
export const WRITING_STYLES: WritingStyleOption[] = [
  { id: 'bouncy-rhymes', label: 'Bouncy Rhymes', description: 'Rhyming and energetic' },
  { id: 'gentle-refrains', label: 'Gentle Refrains', description: 'Soft, repeating, sensory' },
  { id: 'sweet-simple', label: 'Sweet & Simple', description: 'Short lines, big feelings' },
];

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
}

export interface Story {
  id: string;
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
  artStyle: ArtStyle;
  pageCount: number;
  pages?: StoryPage[];
  createdAt: string;
}

export interface GenerateStoryResponse extends Story {
  generationTimeMs: number;
}

// API Functions

/**
 * Generate a new story
 */
export async function generateStory(input: StoryInput): Promise<GenerateStoryResponse> {
  const response = await api.post<GenerateStoryResponse>('/api/stories/generate', input);
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
