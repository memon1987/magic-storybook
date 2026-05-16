import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import admin from 'firebase-admin';
import storiesRouter from './routes/stories';
import spikeRouter from './routes/spike';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

const app = express();
const PORT = process.env.PORT || 8080;

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: true, // Allow all origins in development; restrict in production
  credentials: true,
}));

// Parse JSON bodies
app.use(express.json());

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'ai-storybook-api',
    ai: 'gemini',
  });
});

// API routes
app.use('/api/stories', storiesRouter);
// FC-019 spike route — dev-only text-paradigm comparison. Behavior is gated
// by SPIKE_USE_PRO_IMAGE / SPIKE_USE_RECRAFT env vars; with both OFF the
// route exists but every variant returns enabled:false (no model calls made).
app.use('/api/spike', spikeRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`AI Storybook API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
