/**
 * FC-019 spike helper (dev-only, NOT committed to main as a workflow).
 * Mints a Firebase ID token for the owner of a given story so the spike
 * route can be called without the mobile-app temp-log dance.
 *
 * Flow: ADC (gcloud user creds) signs a custom token AS the firebase-adminsdk
 * SA (requires Token Creator on that SA), then exchanges it for an ID token
 * via the Identity Toolkit REST API.
 *
 * Usage: node scripts/mint-spike-token.js <storyId> <webApiKey>
 */
const admin = require('firebase-admin');

const PROJECT = 'ai-storybook-app-2025';
const SA = 'firebase-adminsdk-fbsvc@ai-storybook-app-2025.iam.gserviceaccount.com';
const storyId = process.argv[2];
const webApiKey = process.argv[3];

if (!storyId || !webApiKey) {
  console.error('Usage: node scripts/mint-spike-token.js <storyId> <webApiKey>');
  process.exit(1);
}

admin.initializeApp({
  projectId: PROJECT,
  serviceAccountId: SA,
});

(async () => {
  const doc = await admin.firestore().collection('stories').doc(storyId).get();
  if (!doc.exists) {
    console.error('Story not found:', storyId);
    process.exit(1);
  }
  const uid = doc.data().userId;
  if (!uid) {
    console.error('Story has no userId');
    process.exit(1);
  }
  console.error('[mint] story owner uid:', uid);

  const customToken = await admin.auth().createCustomToken(uid);
  console.error('[mint] custom token minted, exchanging for ID token...');

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const json = await resp.json();
  if (!resp.ok || !json.idToken) {
    console.error('[mint] exchange failed:', JSON.stringify(json));
    process.exit(1);
  }
  // ID token on stdout (only line on stdout) so callers can capture it cleanly.
  process.stdout.write(json.idToken);
})().catch((e) => {
  console.error('[mint] error:', e.message || e);
  process.exit(1);
});
