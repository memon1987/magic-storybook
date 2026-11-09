# AI Storybook App

An iOS mobile app that generates personalized, AI-powered storybooks for children ages 3-8. Uses Google Gemini for both story text and illustration generation.

## Tech Stack

- **Frontend**: Expo (React Native) with TypeScript
- **Backend**: Node.js/Express on GCP Cloud Run
- **Database**: Cloud Firestore
- **Storage**: GCP Cloud Storage
- **Auth**: Firebase Authentication
- **AI**: Google Gemini API
  - `gemini-3.8-flash` for story text and content moderation
  - `gemini-nano-banana-2.1` (Nano Banana 2.1) for illustrations

## Project Structure

```
ai_storybook_app/
├── backend/           # Express.js API server
│   ├── src/
│   │   ├── index.ts           # Server entry point
│   │   ├── routes/            # API routes
│   │   ├── services/          # Business logic (Gemini, storage)
│   │   ├── prompts/           # AI prompt templates
│   │   └── middleware/        # Auth middleware
│   ├── Dockerfile
│   └── package.json
└── mobile/            # Expo React Native app
    ├── app/
    │   ├── (auth)/            # Login/Register screens
    │   ├── (tabs)/            # Main app tabs
    │   └── story/[id]/        # Story preview and reader
    ├── services/              # API and Firebase clients
    ├── hooks/                 # Custom React hooks
    └── constants/             # Colors and config
```

## Setup Instructions

### 1. GCP Project Setup

```bash
# Create GCP project
gcloud projects create ai-storybook-app --name="AI Storybook App"
gcloud config set project ai-storybook-app

# Link billing
gcloud billing projects link ai-storybook-app --billing-account=YOUR_BILLING_ACCOUNT

# Enable APIs
gcloud services enable run.googleapis.com
gcloud services enable firestore.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable cloudbuild.googleapis.com

# Create Firestore database
gcloud firestore databases create --location=us-central1

# Create Storage bucket
gsutil mb -l us-central1 gs://ai-storybook-app-images
```

### 2. Get Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com)
2. Click "Get API Key" → "Create API Key"
3. Select your GCP project
4. Copy the API key

```bash
# Store in Secret Manager
echo -n 'your-gemini-api-key' | gcloud secrets create gemini-api-key --data-file=-
```

### 3. Firebase Setup

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Add your GCP project
3. Enable Authentication → Email/Password
4. Copy your Firebase config to `mobile/services/firebase.ts`

### 4. Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your values

# Run locally
npm run dev

# Deploy to Cloud Run
npm run build
gcloud run deploy storybook-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars=STORAGE_BUCKET=ai-storybook-app-images \
  --memory 512Mi \
  --timeout 120
```

### 5. Mobile App Setup

```bash
cd mobile

# Install dependencies
npm install

# Update API URL in services/api.ts with your Cloud Run URL
# Update Firebase config in services/firebase.ts

# Run development server
npx expo start

# Build for iOS
eas build --platform ios
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /api/stories/generate | Generate new story |
| GET | /api/stories | List user's stories |
| GET | /api/stories/:id | Get story with pages |
| DELETE | /api/stories/:id | Delete a story |

## Story Generation Request

```json
POST /api/stories/generate
{
  "childName": "Emma",
  "favoriteAnimal": "bunny",
  "setting": "enchanted forest",
  "moral": "kindness",
  "length": "medium",
  "artStyle": "watercolor"
}
```

## Environment Variables

### Backend (.env)
```
GOOGLE_CLOUD_PROJECT=ai-storybook-app
STORAGE_BUCKET=ai-storybook-app-images
GEMINI_API_KEY=your-api-key
PORT=8080
NODE_ENV=development
```

### Mobile (services/firebase.ts)
Update the Firebase config object with your project's values.

### Mobile (services/api.ts)
Update `API_URL` with your Cloud Run service URL.

## License

MIT
