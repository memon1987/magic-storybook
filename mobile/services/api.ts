import axios, { AxiosInstance } from 'axios';
import { getIdToken } from './firebase';

// API base URL
const API_URL = 'https://storybook-api-983903024759.us-central1.run.app';

// Create axios instance
const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 120000, // 2 minutes for story generation
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

export interface StoryInput {
  childName: string;
  childGender?: 'boy' | 'girl';
  favoriteAnimal?: string;
  specialFriendName?: string;
  specialFriendDescription?: string;
  setting: string;
  moral: string;
  authorStyle?: string;
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
