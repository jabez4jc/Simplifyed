/**
 * Authentication Middleware
 * Handles authentication using Passport (Google OAuth) with test mode support
 */

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'fs';
import path from 'path';
import db from '../core/database.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

/**
 * Configure session middleware with persistent SQLite store
 *
 * CRITICAL FIX: Now uses SQLite session store for persistence
 * - Sessions persist across server restarts
 * - Suitable for single-instance deployments
 * - For multi-instance deployments, consider Redis instead
 */
export function configureSession() {
  const SQLiteStore = connectSqlite3(session);

  const sessionConfig = {
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.env === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  };

  // CRITICAL FIX: Ensure ./data directory exists before creating SQLiteStore
  // This prevents SQLITE_CANTOPEN error on fresh checkouts
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      log.info('Created data directory for session storage', { path: dataDir });
    } catch (error) {
      log.error('Failed to create data directory for sessions', error);
      throw new Error(`Cannot create session storage directory: ${error.message}`);
    }
  }

  // Use persistent SQLite session store
  // This ensures sessions persist across restarts
  sessionConfig.store = new SQLiteStore({
    db: 'sessions.db',
    dir: dataDir,
    table: 'sessions',
    // Clean up expired sessions every hour
    concurrentDB: true,
  });

  log.info('Session store configured with SQLite persistence', {
    dbPath: path.join(dataDir, 'sessions.db'),
    ttl: '24 hours'
  });

  return session(sessionConfig);
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
 *
 * SECURITY FIX: Test mode now requires explicit ENABLE_TEST_MODE=true flag
 * to prevent accidental unauthenticated access
 */
export function requireAuth(req, res, next) {
  // CRITICAL: Test mode MUST be explicitly enabled via environment variable
  // This prevents accidental admin access if Google OAuth is misconfigured
  const testModeEnabled = config.auth.enableTestMode === true ||
                          process.env.ENABLE_TEST_MODE === 'true';

  if (config.env === 'development' && testModeEnabled && !config.auth.googleClientId) {
    log.warn('⚠️  TEST MODE ACTIVE - Bypassing authentication (INSECURE)', {
      endpoint: req.path,
      method: req.method
    });
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
 *
 * SECURITY FIX: Test mode now requires explicit ENABLE_TEST_MODE=true flag
 */
export function requireAdmin(req, res, next) {
  // CRITICAL: Test mode MUST be explicitly enabled
  const testModeEnabled = config.auth.enableTestMode === true ||
                          process.env.ENABLE_TEST_MODE === 'true';

  if (config.env === 'development' && testModeEnabled && !config.auth.googleClientId) {
    log.warn('⚠️  TEST MODE ACTIVE - Bypassing admin check (INSECURE)', {
      endpoint: req.path,
      method: req.method
    });
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
 *
 * SECURITY FIX: Test mode now requires explicit ENABLE_TEST_MODE=true flag
 */
export function optionalAuth(req, res, next) {
  // CRITICAL: Test mode MUST be explicitly enabled
  const testModeEnabled = config.auth.enableTestMode === true ||
                          process.env.ENABLE_TEST_MODE === 'true';

  if (config.env === 'development' && testModeEnabled && !config.auth.googleClientId) {
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
