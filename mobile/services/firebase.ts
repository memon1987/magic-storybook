import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
// getReactNativePersistence ships only in firebase's React Native build. The
// `firebase/auth` meta-package exposes no `react-native` export condition for
// its TYPES (only types/node/browser/default), so tsc resolves the web typings
// where this symbol is absent — but Metro resolves the RN build at runtime, so
// the call works. The @ts-expect-error self-cleans if firebase ever ships RN
// typings here.
// @ts-expect-error - RN-only export, missing from firebase/auth web typings
import { getReactNativePersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
const isNewApp = getApps().length === 0;
const app = isNewApp ? initializeApp(firebaseConfig) : getApps()[0];

// Auth must be initialized with React Native persistence so the session
// survives an app cold-start. The Firebase JS SDK defaults to in-memory
// persistence on RN — without AsyncStorage-backed persistence the user is
// silently logged out every time the OS tears down the process.
//
// initializeAuth() may only be called once per app; on Fast Refresh (or any
// re-eval where the firebase app already exists) fall back to getAuth(), which
// returns the already-configured instance.
//
// FRAGILITY NOTE: this guard keys off app existence, not auth-init state. It is
// correct only because this module is the SOLE initializeApp() call site. If a
// second site is ever added (e.g. firebase/messaging setup that runs first),
// getApps() would already be non-empty here, the getAuth() branch would run
// before persistence was wired, and the in-memory-logout bug would silently
// return. Any new initializeApp() call must keep this the first one, or this
// guard must be reworked to key off auth-initialization state.
export const auth = isNewApp
  ? initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    })
  : getAuth(app);
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
