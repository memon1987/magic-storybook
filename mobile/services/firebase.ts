import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
// FC-017 Phase 3+4: Firestore client for onSnapshot subscriptions to
// in-flight story docs. Backend writes to the `stories` collection; mobile
// reads via Firestore Security Rules (gated to doc owner).
import { getFirestore } from 'firebase/firestore';

const PLACEHOLDER_PATTERN = /^(your-|XXXX|0000)/;

// Static literal accesses to process.env so Metro/Babel can inline EXPO_PUBLIC_*
// at bundle time. Dynamic process.env[name] is NOT inlined — values come back
// undefined at runtime in Release builds.
const RAW_ENV = {
  EXPO_PUBLIC_FIREBASE_API_KEY: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  EXPO_PUBLIC_FIREBASE_APP_ID: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
} as const;

function validate(raw: typeof RAW_ENV): Record<keyof typeof RAW_ENV, string> {
  const missing: string[] = [];
  const placeholder: string[] = [];
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!v) {
      missing.push(name);
    } else if (PLACEHOLDER_PATTERN.test(v)) {
      placeholder.push(name);
    } else {
      values[name] = v;
    }
  }
  if (missing.length > 0 || placeholder.length > 0) {
    const parts: string[] = [];
    if (missing.length) parts.push(`Missing: ${missing.join(', ')}`);
    if (placeholder.length) parts.push(`Still set to placeholder values: ${placeholder.join(', ')}`);
    throw new Error(
      `${parts.join('; ')}. Copy mobile/.env.example to mobile/.env and populate with real values.`
    );
  }
  return values as Record<keyof typeof RAW_ENV, string>;
}

const env = validate(RAW_ENV);
const firebaseConfig = {
  apiKey: env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// Initialize Firebase (only once)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);
// FC-017 Phase 3+4: shared Firestore client used by services/stories.ts
// for onSnapshot subscriptions. Reads gated by Firestore Security Rules
// (only the doc's userId can read).
export const db = getFirestore(app);

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
