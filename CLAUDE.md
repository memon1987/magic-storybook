# AI Storybook App - Claude Code Guide

## Project Overview

**AI Storybook App** is a mobile application that generates personalized children's storybooks using AI. Parents input their child's name, favorite animal, setting, and moral lesson, and the app generates a complete illustrated story with text embedded directly into the illustrations (Dr. Seuss/Pout-Pout Fish style).

### Tech Stack
- **Backend**: Node.js/Express + TypeScript, deployed on Google Cloud Run
- **Mobile**: React Native with Expo (Expo Router for navigation)
- **Database**: Google Cloud Firestore
- **Storage**: Google Cloud Storage (for illustration images)
- **Auth**: Firebase Authentication (email/password)
- **AI Models**:
  - Text Generation: `gemini-2.0-flash`
  - Image Generation: `gemini-3-pro-image-preview` (94% text accuracy)

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
│   │   │   ├── gemini.ts      # AI generation (Gemini 3 Pro Image)
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
const TEXT_MODEL = 'gemini-2.0-flash';           // Story text generation
const IMAGE_MODEL = 'gemini-3-pro-image-preview'; // Image generation (94% text accuracy)
```

### Image Generation Pattern

The app uses `generateContent` with IMAGE modality (NOT `generateImages`):

```typescript
const response = await ai.models.generateContent({
  model: IMAGE_MODEL,
  contents: prompt,
  config: {
    responseModalities: ['IMAGE'],
  },
});

// Extract image from response
const parts = response.candidates[0]?.content?.parts || [];
for (const part of parts) {
  if (part.inlineData?.data) {
    const buffer = Buffer.from(part.inlineData.data, 'base64');
    // Upload to Cloud Storage...
  }
}
```

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

### Mobile (`.env` / app.config.js)

```bash
EXPO_PUBLIC_API_URL=https://storybook-api-XXXXX.us-central1.run.app
EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=
EXPO_PUBLIC_FIREBASE_PROJECT_ID=
```

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

**Cause**: Gemini 3 Pro Image experiencing high demand

**Solution**: Retry logic with exponential backoff implemented in `gemini.ts`

**Fallback**: Returns placeholder image URL after 3 failed attempts

### 2. Text Rendering Accuracy

**Previous Issue**: Imagen 4 had ~70% text accuracy (nonsensical text in images)

**Solution**: Switched to `gemini-3-pro-image-preview` with ~94% accuracy

**Cost Impact**: ~3x higher per image ($0.13-0.24 vs $0.04)

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
| Story text generation | ✅ Complete | Gemini 2.0 Flash |
| Image generation | ✅ Complete | Gemini 3 Pro Image |
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

Gemini 3 Pro Image returns images in this structure:
```typescript
response.candidates[0].content.parts[0].inlineData = {
  data: string;      // Base64 encoded image
  mimeType: string;  // 'image/png' or 'image/jpeg'
}
```

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
2. Backend generates story text with Gemini 2.0 Flash
3. For each page, generates illustration with Gemini 3 Pro Image
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
