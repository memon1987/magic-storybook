import { Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { AuthRequest } from '../types';

/**
 * Firebase Authentication Middleware
 * Verifies the Bearer token from the Authorization header
 * and attaches the decoded user to the request object.
 */
export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  // Check for Authorization header
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header missing' });
    return;
  }

  // Check for Bearer token format
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
    return;
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token) {
    res.status(401).json({ error: 'Token missing' });
    return;
  }

  try {
    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Attach user info to request
    req.user = decodedToken;

    next();
  } catch (error) {
    console.error('Auth error:', error);

    // Handle specific Firebase auth errors
    if (error instanceof Error) {
      if (error.message.includes('expired')) {
        res.status(401).json({ error: 'Token expired' });
        return;
      }
      if (error.message.includes('invalid')) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    res.status(401).json({ error: 'Authentication failed' });
  }
}
