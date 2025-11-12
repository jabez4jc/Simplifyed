/**
 * Authentication Middleware
 * Handles authentication using Passport (Google OAuth) with test mode support
 */

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import db from '../core/database.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

/**
 * Configure session middleware
 *
 * WARNING: Currently uses in-memory session store for development.
 * For production deployments:
 * - Sessions will be lost on server restart
 * - Multi-instance deployments will have inconsistent sessions
 *
 * Production alternatives:
 * - connect-sqlite3 for single-instance deployments
 * - connect-redis for multi-instance deployments
 * - @quixo3/prisma-session-store for existing Prisma setups
 */
export function configureSession() {
  // TODO: Implement persistent session store for production
  // Use environment variable to select store type
  if (config.env === 'production') {
    log.warn('Using in-memory session store in production - sessions will not persist across restarts');
  }

  return session({
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.env === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  });
}

/**
 * Configure Passport with Google OAuth strategy
 */
export function configurePassport() {
  // Only configure Google OAuth if credentials are provided
  if (config.auth.googleClientId && config.auth.googleClientSecret) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: config.auth.googleClientId,
          clientSecret: config.auth.googleClientSecret,
          callbackURL: `${config.baseUrl}/auth/google/callback`,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            // Validate email exists in profile
            if (!profile.emails || profile.emails.length === 0) {
              const error = new Error('No email address found in Google profile');
              log.error('OAuth profile missing email', { profileId: profile.id });
              return done(error);
            }

            const email = profile.emails[0].value;

            // Check if user exists
            let user = await db.get('SELECT * FROM users WHERE email = ?', [
              email,
            ]);

            if (!user) {
              // Create new user
              const result = await db.run(
                'INSERT INTO users (email, is_admin) VALUES (?, ?)',
                [email, 0] // New users are not admin by default
              );

              user = await db.get('SELECT * FROM users WHERE id = ?', [
                result.lastID,
              ]);

              log.info('New user created', { email });
            }

            return done(null, user);
          } catch (error) {
            log.error('Authentication error', error);
            return done(error);
          }
        }
      )
    );

    passport.serializeUser((user, done) => {
      done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
      try {
        const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        done(null, user);
      } catch (error) {
        done(error);
      }
    });

    log.info('Google OAuth authentication configured');
  } else {
    log.warn('Google OAuth credentials not found - running in test mode');
  }

  return passport.initialize();
}

/**
 * Middleware to require authentication
 * In test mode, creates a test user
 */
export function requireAuth(req, res, next) {
  // Test mode: Allow all requests with test user
  if (config.env === 'development' && !config.auth.googleClientId) {
    req.user = {
      id: 1,
      email: 'test@example.com',
      is_admin: 1,
    };
    return next();
  }

  if (req.isAuthenticated()) {
    return next();
  }

  throw new UnauthorizedError('Authentication required');
}

/**
 * Middleware to require admin access
 */
export function requireAdmin(req, res, next) {
  // Test mode: Allow all requests
  if (config.env === 'development' && !config.auth.googleClientId) {
    return next();
  }

  if (!req.isAuthenticated()) {
    throw new UnauthorizedError('Authentication required');
  }

  if (!req.user.is_admin) {
    throw new ForbiddenError('Admin access required');
  }

  next();
}

/**
 * Optional auth middleware
 * Attaches user if authenticated, but doesn't require it
 */
export function optionalAuth(req, res, next) {
  // Test mode: Add test user
  if (config.env === 'development' && !config.auth.googleClientId) {
    req.user = {
      id: 1,
      email: 'test@example.com',
      is_admin: 1,
    };
  }

  next();
}

export default {
  configureSession,
  configurePassport,
  requireAuth,
  requireAdmin,
  optionalAuth,
};
