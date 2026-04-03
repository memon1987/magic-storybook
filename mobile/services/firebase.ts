import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';

// Firebase configuration
const firebaseConfig = {
  apiKey: 'AIzaSyBEOhJTwkJ1R5zjKc73ekUGs55a4Sog_98',
  authDomain: 'ai-storybook-app-2025.firebaseapp.com',
  projectId: 'ai-storybook-app-2025',
  storageBucket: 'ai-storybook-app-2025.firebasestorage.app',
  messagingSenderId: '983903024759',
  appId: '1:983903024759:ios:8659dfeaebb3ad54923872',
};

// Initialize Firebase (only once)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);

/**
 * Register a new user with email and password
 */
export async function register(email: string, password: string): Promise<User> {
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

/**
 * Sign in with email and password
 */
export async function signIn(email: string, password: string): Promise<User> {
  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

/**
 * Get the current user's ID token for API calls
 */
export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

/**
 * Subscribe to auth state changes
 */
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export default auth;
