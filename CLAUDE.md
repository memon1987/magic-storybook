# AI Storybook App - Claude Code Guide

## Plan-First Development

**CRITICAL RULE:** Medium and large code changes must have a published execution plan in `docs/plans/` before any code is written. Ideas that have not yet graduated to a plan live in `docs/FUTURE_CONSIDERATIONS.md`.

### Lifecycle
```
docs/FUTURE_CONSIDERATIONS.md  →  docs/plans/fc-NNN.md  →  code change
        (FC entry)                  (published plan)        (commit/PR)
```

### Plan file naming
Plan files must be named `fc-NNN.md` matching their FUTURE_CONSIDERATIONS entry number for traceability (e.g., FC-006 → `docs/plans/fc-006.md`).

### What counts as "medium or large"
Any change that meets **any** of the following requires a plan file:
- Roughly 50+ lines changed
- Touches more than one screen or service file
- Alters runtime behavior, API contracts, or auth flow
- Adds or removes dependencies
- Changes deployment, CI, or app configuration

What is **exempt** (no plan needed):
- Typos, comment/docstring edits, formatting
- Single-file, isolated bug fixes under ~50 lines that don't change behavior
- Edits to `docs/FUTURE_CONSIDERATIONS.md`, `docs/plans/*`, and release notes
- Test-only additions that don't change production code

### Enforcement for Claude Code sessions
When the user requests a change that qualifies as medium/large:
1. Check `docs/plans/` for a plan file matching the work.
2. If no plan exists, **stop and surface it**: point at the relevant FC entry (or propose one) and ask the user to either (a) have a plan drafted first or (b) explicitly override.
3. Do **not** start coding until one of those two paths is chosen.

### Override
The user may override the plan requirement by saying so explicitly. When overridden, note the override in the commit message (e.g., `[no-plan: reason]`).

### Referencing plans
- Commit messages and PR descriptions should include: `Plan: docs/plans/fc-NNN.md`.
- After merge, update the FC entry's status and move it to "Completed" with a link to the plan and commit/PR.
- **One PR per FC:** Each FC must have its own dedicated PR for clean rollback.

### Post-execution plan updates
After implementation is complete, update the plan file:
- Change `**Status:**` to `Executing` (PR open) or `Done` (PR merged)
- Add PR URL, commit SHA, date, and deviation notes to the `## Execution` section

### Files
- `docs/FUTURE_CONSIDERATIONS.md` — pre-plan ideas, FC-NNN format
- `docs/plans/README.md` — plan workflow, index, naming
- `docs/plans/_template.md` — template to copy for new plans
- `docs/plans/fc-NNN.md` — individual published plans

---

## Project Overview

**AI Storybook App** is a mobile application that generates personalized children's storybooks using AI. Parents input their child's name, favorite animal, setting, and moral lesson, and the app generates a complete illustrated story with text embedded directly into the illustrations (Dr. Seuss/Pout-Pout Fish style).

### Tech Stack
- **Backend**: Node.js/Express + TypeScript, deployed on Google Cloud Run
- **Mobile**: React Native with Expo (Expo Router for navigation)
- **Database**: Google Cloud Firestore
- **Storage**: Google Cloud Storage (for illustration images)
- **Auth**: Firebase Authentication (email/password)
- **AI Models**:
  - Text Generation (story text + both moderation classifiers): `gemini-3-flash-preview` (deliberately still preview — FC-047)
  - Image Generation: `gemini-nano-banana-2.1` ("Nano Banana 2.1"; latency / text-accuracy: see `docs/plans/fc-045.md` Execution)

---

## Project Structure

```
ai_storybook_app/
├── backend/                    # Express API server
│   ├── src/
│   │   ├── index.ts           # Server entry point (port 8080)
│   │   ├── routes/
│   │   │   ├── auth.ts        # POST /api/auth/register, /api/auth/login
│   │   │   └── stories.ts     # POST /api/stories/generate, GET /api/stories, GET /api/stories/:id
│   │   ├── services/
│   │   │   ├── gemini.ts      # AI generation (gemini-3-flash-preview text, gemini-nano-banana-2.1 images)
│   │   │   └── firebase.ts    # Firebase Admin SDK init
│   │   ├── middleware/
│   │   │   └── auth.ts        # Firebase ID token verification
│   │   ├── prompts/
│   │   │   ├── story.ts       # Story text generation prompts
│   │   │   └── illustration.ts # Image generation prompts (Dr. Seuss style)
│   │   └── types/
│   │       └── index.ts       # TypeScript interfaces
│   ├── Dockerfile             # Cloud Run container config
│   └── package.json
│
├── mobile/                     # Expo React Native app
│   ├── app/                   # Expo Router pages
│   │   ├── _layout.tsx        # Root layout (fonts, auth provider)
│   │   ├── index.tsx          # Entry redirect
│   │   ├── (auth)/            # Auth screens (unauthenticated)
│   │   │   ├── login.tsx
│   │   │   └── register.tsx
│   │   ├── (tabs)/            # Main app tabs (authenticated)
│   │   │   ├── _layout.tsx    # Tab navigation config
│   │   │   ├── index.tsx      # Library (My Stories)
│   │   │   ├── create.tsx     # Create Story form
│   │   │   └── settings.tsx   # User settings
│   │   └── story/[id]/        # Story detail screens
│   │       ├── preview.tsx    # Story preview before reading
│   │       └── read.tsx       # Full-page story reader
│   ├── services/
│   │   └── api.ts             # API client (axios + auth interceptor)
│   ├── hooks/
│   │   └── useAuth.tsx        # Firebase Auth hook + context
│   ├── constants/
│   │   ├── Colors.ts          # V2 color palette
│   │   └── Typography.ts      # Font configuration
│   └── package.json
│
└── CLAUDE.md                   # This file
```

---

## Key Files Reference

### Backend - Core Logic

| File | Purpose | Key Exports |
|------|---------|-------------|
| `backend/src/services/gemini.ts` | AI generation service | `generateStory()`, `generateIllustration()`, `generateAllIllustrations()` |
| `backend/src/prompts/illustration.ts` | Image prompt builder | `buildIllustrationPrompt()` - Dr. Seuss/Pout-Pout Fish style |
| `backend/src/prompts/story.ts` | Story prompt builder | `buildStoryPrompt()` |
| `backend/src/routes/stories.ts` | Story API endpoints | POST generate, GET list, GET by ID |
| `backend/src/types/index.ts` | Type definitions | `StoryInput`, `GeneratedStory`, `ArtStyle` |

### Mobile - Key Screens

| File | Purpose | Notes |
|------|---------|-------|
| `mobile/app/(tabs)/create.tsx` | Story creation form | 6 art styles, child info input |
| `mobile/app/(tabs)/index.tsx` | Story library | Lists user's stories |
| `mobile/app/story/[id]/read.tsx` | Full-page reader | Horizontal swipe, black background |
| `mobile/services/api.ts` | API client | Axios + Firebase token interceptor |
| `mobile/hooks/useAuth.tsx` | Auth context | Login, register, logout, user state |

---

## Art Styles (6 Total)

```typescript
type ArtStyle =
  | 'watercolor'        // Soft, dreamy watercolor
  | 'cartoon'           // Bold outlines, vibrant colors
  | 'storybook-classic' // Nostalgic, warm, timeless
  | 'claymation'        // Wallace & Gromit style 3D
  | 'studio-ghibli'     // Ghibli-inspired, magical
  | 'pixar-3d';         // Pixar-style polished 3D
```

Defined in:
- `backend/src/types/index.ts` (line 21)
- `backend/src/routes/stories.ts` (validation, line 51)
- `backend/src/prompts/illustration.ts` (style descriptions)
- `mobile/services/api.ts` (line 26)

---

## AI Model Configuration

### Current Models (in `backend/src/services/gemini.ts`)

```typescript
const TEXT_MODEL = 'gemini-3-flash-preview';   // Story text + text/vision moderation classifiers (deliberately preview — FC-047)
const IMAGE_MODEL = 'gemini-nano-banana-2.1';   // Image generation (figures: docs/plans/fc-045.md Execution)
```

The image model moved to a GA ID in FC-045. `TEXT_MODEL` **deliberately** stays on a preview ID:
it also runs both fail-closed safety classifiers, so moving it needs the labelled safety
evaluation in FC-047. `gemini-models.test.ts` fails if any *new* `preview` / `exp` /
`experimental` / `latest` ID is pinned (only `gemini-3-flash-preview` is allow-listed).

### Image Generation Pattern

The app uses `generateContent` with IMAGE modality (NOT `generateImages`):

```typescript
const response = await ai.models.generateContent({
  model: IMAGE_MODEL,
  contents: prompt,
  config: {
    responseModalities: ['IMAGE'],
    safetySettings: SAFETY_SETTINGS,
  },
});

// Extract the FINAL image (backend/src/services/imageResponse.ts)
const image = extractGeneratedImage(response);
if (!image) {
  // throw "No image data in ... response" (+ " — safety blocked: <reason>")
}
const buffer = Buffer.from(image.data, 'base64');
// Upload to Cloud Storage with image.mimeType...
```

The response *may* include interim "thinking" draft images flagged `thought: true` (not yet
observed on this model). If present, `extractGeneratedImage` skips them; it returns the **last**
non-thought image part and never falls back to a draft.

### Retry Logic

503 errors (high demand) are handled with exponential backoff:
- 3 max retries
- Delays: 2s → 4s → 8s
- Falls back to placeholder image on total failure

---

## V2 Design System

### Color Palette (`mobile/constants/Colors.ts`)

| Color | Hex | Usage |
|-------|-----|-------|
| Sunshine Yellow | `#FFD93D` | Primary buttons, highlights |
| Sky Blue (green) | `#6BCB77` | Secondary, success |
| Coral Pink | `#FF6B6B` | Accent, tab selected |
| Cream | `#FFF9E8` | Background |
| Lavender | `#C9B1FF` | Highlight accents |
| Dark Charcoal | `#2D3748` | Text |

### Typography (`mobile/constants/Typography.ts`)

- **Nunito**: Headings and titles
- **Quicksand**: Body text
- **Baloo 2**: Display/fun text (buttons)

Fonts loaded in `mobile/app/_layout.tsx` using `expo-font` and `@expo-google-fonts/*`.

---

## Database Schema (Firestore)

### Collection: `stories`

```typescript
{
  id: string;              // Auto-generated
  userId: string;          // Firebase Auth UID
  title: string;           // Generated story title
  childName: string;       // Input
  favoriteAnimal: string;  // Input
  setting: string;         // Input (forest, beach, space, etc.)
  moral: string;           // Input (kindness, courage, etc.)
  artStyle: ArtStyle;      // Input (6 options)
  length: 'short' | 'medium' | 'long';
  pages: StoryPage[];      // Array of pages
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface StoryPage {
  pageNumber: number;
  text: string;           // Story text for this page
  sceneDescription: string; // For image generation
  imageUrl: string;       // Cloud Storage URL
}
```

---

## Environment Variables

### Backend (`.env` / Cloud Run secrets)

```bash
GEMINI_API_KEY=           # Google AI API key
FIREBASE_PROJECT_ID=      # Firebase project ID
FIREBASE_PRIVATE_KEY=     # Service account private key (base64)
FIREBASE_CLIENT_EMAIL=    # Service account email
STORAGE_BUCKET=           # GCS bucket name (e.g., storybook-assets)
PORT=8080                 # Cloud Run default
```

### Mobile (`mobile/.env`)

Required by `services/firebase.ts` and `services/api.ts` — module-load throws if any are missing. Copy `mobile/.env.example` and populate.

```bash
EXPO_PUBLIC_API_URL=https://storybook-api-XXXXX.us-central1.run.app

EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=
EXPO_PUBLIC_FIREBASE_PROJECT_ID=
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
EXPO_PUBLIC_FIREBASE_APP_ID=
```

`EXPO_PUBLIC_*` vars are inlined into the JS bundle at build time. **Anything you put under this prefix ends up as plaintext in the production app binary** — fine for Firebase web API keys (designed-public; Firestore Security Rules enforce auth) and the Cloud Run URL (designed-public), but never put a truly-secret value here. Truly secret values (e.g. a third-party API key the backend doesn't proxy) must live on the backend, not the mobile app.

For EAS Build, the same vars must also live under each profile's `env` block in `mobile/eas.json` — `mobile/.env` is gitignored and therefore not uploaded to EAS. `mobile/.env` is for local `expo start` / `expo run:ios` only; `mobile/eas.json` is the source of truth for cloud builds.

---

## Deployment

### Backend (Cloud Run)

```bash
cd backend

# Build and deploy
gcloud run deploy storybook-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=...,STORAGE_BUCKET=..."

# View logs
gcloud run services logs read storybook-api --region us-central1

# Health check
curl https://storybook-api-XXXXX.us-central1.run.app/health
```

### Mobile (Expo)

```bash
cd mobile

# Development
npx expo start

# Build for production
eas build --platform ios
eas build --platform android
```

**MANDATORY pre-submit gate (mobile):** before promoting any EAS iOS production build to
TestFlight/testers (`eas submit -p ios`), run the on-device smoke test in
[docs/runbooks/mobile-release-preflight.md](docs/runbooks/mobile-release-preflight.md) on a
**physical device against the release build** — at minimum: open a story and turn pages both
directions, then generate a story end-to-end. This is not optional: TestFlight build 14 shipped
a reader page-turn crash (FC-044) that was **invisible in dev and passed two code reviews +
`tsc`** because it was a release-only worklet failure. There is no mobile test runner yet
(FC-024) to catch runtime/crash behavior, so this human gate is the backstop. Never submit a
build you have not turned a page on.

---

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account (email, password, name)
- `POST /api/auth/login` - Login (email, password) → returns Firebase ID token

### Stories (requires `Authorization: Bearer <firebase-id-token>`)
- `POST /api/stories/generate` - Generate new story
- `GET /api/stories` - List user's stories
- `GET /api/stories/:id` - Get single story with pages

### Generate Story Request Body

```typescript
{
  childName: string;
  favoriteAnimal: string;
  setting: 'forest' | 'beach' | 'space' | 'underwater' | 'castle' | 'jungle';
  moral: 'kindness' | 'courage' | 'friendship' | 'honesty' | 'perseverance' | 'sharing';
  length: 'short' | 'medium' | 'long';  // 5, 8, or 12 pages
  artStyle: ArtStyle;
}
```

---

## Known Issues & Solutions

### 1. 503 Service Unavailable (Image Generation)

**Cause**: image model (`gemini-nano-banana-2.1`) experiencing high demand

**Solution**: Retry logic with exponential backoff implemented in `gemini.ts`

**Fallback**: Returns placeholder image URL after 3 failed attempts

### 2. Text Rendering Accuracy

**History**:
- Imagen 4 had ~70% text accuracy (nonsensical text in images) — abandoned
- `gemini-3-pro-image-preview` ("Nano Banana Pro") gave ~94% accuracy at ~$0.13/image but 24-35s/image latency
- Then `gemini-3.1-flash-image-preview` ("Nano Banana 2"): ~90% accuracy, 4-6s/image, ~$0.067/image — chose speed over the last 4% of accuracy.
- Moved to `gemini-nano-banana-2.1` in FC-045 because the preview ID was deprecated (past its listed shutdown date). Current figures: see `docs/plans/fc-045.md` Execution. Pre-approved fallback: `gemini-3.1-flash-image`.

### 3. Port Conflicts (Development)

If Expo Metro bundler port 8081 is in use:
```bash
lsof -i :8081  # Find process
kill -9 <PID>  # Or use existing server
```

---

## Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| Story text generation | ✅ Complete | `gemini-3-flash-preview` (FC-047) |
| Image generation | ✅ Complete | `gemini-nano-banana-2.1` |
| Text in images | ✅ Complete | Dr. Seuss/Pout-Pout style |
| 6 art styles | ✅ Complete | All working |
| V2 color palette | ✅ Complete | Cream/yellow/coral theme |
| Custom fonts | ✅ Complete | Nunito, Quicksand, Baloo 2 |
| Firebase Auth | ✅ Complete | Email/password |
| Story library | ✅ Complete | Lists user's stories |
| Full-page reader | ✅ Complete | Horizontal swipe |
| Story preview | ✅ Complete | Cover + metadata |

---

## Development Commands

```bash
# Backend
cd backend
npm install
npm run dev           # Local development (nodemon)
npm run build         # TypeScript compile
npm start             # Production start

# Mobile
cd mobile
npm install
npx expo start        # Start Metro bundler
npx expo start --ios  # iOS simulator
npx expo start --android  # Android emulator

# Logs
gcloud run services logs read storybook-api --region us-central1 --limit 50
```

---

## Critical Implementation Details

### 1. Image Generation Response Format

Image responses are read as `inlineData` parts in `candidates[0].content.parts`. This is the shape
the previous image model returned and the shape the code expects; it is **not yet observed** on
`gemini-nano-banana-2.1` (FC-045 live verification asserts it, including PNG/JPEG):
```typescript
part.inlineData = {
  data: string;      // Base64 encoded image
  mimeType: string;  // expected 'image/png' or 'image/jpeg' — the pipeline assumes one of these
}
part.thought?: boolean; // may be true on interim "thinking" draft images — skipped if present
```
Whether this model returns thought parts via `generateContent` has not been observed yet. Either
way, the final image is taken as the last part without `thought: true` (see `extractGeneratedImage`).

### 2. Text Embedding in Images

Text is embedded INTO illustrations (not overlaid). The prompt in `illustration.ts` includes:
- Exact page text to render
- Contextual layout instructions (dialogue near characters, sound effects, etc.)
- Dr. Seuss/Pout-Pout Fish style guidelines

### 3. Auth Flow

Mobile app uses Firebase Auth SDK directly. Backend verifies tokens:
```typescript
// Mobile: Gets ID token
const token = await user.getIdToken();

// Backend: Verifies token
const decodedToken = await admin.auth().verifyIdToken(token);
req.user = { uid: decodedToken.uid, email: decodedToken.email };
```

### 4. Story Generation Flow

1. User submits form → `POST /api/stories/generate`
2. Backend generates story text with `gemini-3-flash-preview`
3. For each page, generates illustration with `gemini-nano-banana-2.1`
4. Images uploaded to Cloud Storage
5. Story document saved to Firestore
6. Response returned with full story data

---

## Next Steps / Future Work

- [ ] Text-to-speech narration for stories
- [ ] Multi-language support
- [ ] Story sharing/gifting features
- [ ] Subscription/payment integration
- [ ] Offline story caching
- [ ] Parent dashboard with reading analytics
