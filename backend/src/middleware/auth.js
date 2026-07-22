import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import db from '../core/database.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

const LOCAL_TOKEN_TTL = '7d';

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export function signLocalToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, config.auth.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: LOCAL_TOKEN_TTL,
  });
}

// JWKS client for Supabase ES256 JWT verification
let jwksClientInstance = null;

function getJwksClient() {
  if (!jwksClientInstance && config.auth.supabaseUrl) {
    jwksClientInstance = jwksClient({
      jwksUri: `${config.auth.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }
  return jwksClientInstance;
}

async function getSigningKey(header) {
  const client = getJwksClient();
  if (!client) return null;

  try {
    const key = await client.getSigningKey(header.kid);
    return key.getPublicKey();
  } catch (error) {
    log.warn('Failed to get signing key from JWKS', { error: error.message });
    return null;
  }
}

// Session configuration with persistent SQLite store
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

  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  sessionConfig.store = new SQLiteStore({
    db: 'sessions.db',
    dir: dataDir,
    table: 'sessions',
    concurrentDB: true,
  });

  log.info('Session store configured with SQLite persistence', {
    dbPath: path.join(dataDir, 'sessions.db'),
    ttl: '24 hours',
  });

  return session(sessionConfig);
}

// Helper to fetch user with role/permissions
async function attachRoleAndPermissions(userId) {
  if (!userId) return null;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;

  const roleRow = await db.get(
    `SELECT r.id as role_id, r.name as role
     FROM user_roles ur
     JOIN roles r ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [user.id]
  );

  const permissions = roleRow
    ? await db.all(
        `SELECT p.key
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ?`,
        [roleRow.role_id]
      )
    : [];

  return {
    ...user,
    role: roleRow?.role || null,
    permissions: permissions?.map((p) => p.key) || [],
  };
}

async function ensureLocalUserFromToken(payload) {
  const email = (payload.email || '').toLowerCase();
  const externalId = payload.sub || email;

  log.debug('Looking up user from token', {
    tokenEmail: email,
    sub: payload.sub,
    lookupEmail: email || externalId
  });

  if (!externalId) {
    log.warn('No email or sub in token payload');
    return null;
  }

  let user = await db.get('SELECT * FROM users WHERE email = ?', [email || externalId]);

  if (!user) {
    log.info('User not found, creating new user', { email: email || externalId });
    const countRow = await db.get('SELECT COUNT(*) as count FROM users');
    const isFirstUser = (countRow?.count || 0) === 0;
    const result = await db.run(
      'INSERT INTO users (email, is_admin, password_hash) VALUES (?, ?, NULL)',
      [email || externalId, isFirstUser ? 1 : 0]
    );
    const userId = result.lastID;
    if (isFirstUser) {
      const roleRow = await db.get('SELECT id FROM roles WHERE name = ?', ['Admin']);
      if (roleRow?.id) {
        await db.run(
          `INSERT OR REPLACE INTO user_roles (user_id, role_id, assigned_by)
           VALUES (?, ?, NULL)`,
          [userId, roleRow.id]
        );
      }
    }
    user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  } else {
    log.debug('User found in database', { userId: user.id, email: user.email });
  }

  return attachRoleAndPermissions(user.id);
}

// Optional auth: Supabase is the sole login source (see public/login.html). Attaches req.user
// from a verified Supabase bearer token, or from test mode when enabled. The Express session
// (configureSession) is unrelated to this - it only backs WS gateway cookie auth.
export async function optionalAuth(req, res, next) {
  try {
    const testModeEnabled =
      config.auth.enableTestMode === true ||
      process.env.ENABLE_TEST_MODE === 'true' ||
      config.testMode?.enabled === true;

    if (testModeEnabled) {
      req.user = {
        id: 1,
        email: 'test@example.com',
        is_admin: 1,
        role: 'Admin',
        permissions: [],
      };
      req.isAuthenticated = () => true;
      if (req.app?.locals?.startServices) {
        await req.app.locals.startServices();
      }
      return next();
    }

    // Bearer token: locally-issued JWT (email/password login) or Supabase
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      try {
        const localPayload = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
        const user = await attachRoleAndPermissions(parseInt(localPayload.sub, 10));
        if (user) {
          log.debug('User authenticated via local token', { userId: user.id, email: user.email });
          req.user = user;
          req.isAuthenticated = () => true;
          if (req.app?.locals?.startServices) {
            await req.app.locals.startServices();
          }
          return next();
        }
      } catch {
        // Not a locally-issued token (or user was deleted) - fall through to Supabase below.
      }
    }

    if (token && config.auth.supabaseUrl) {
      try {
        log.debug('Attempting to verify Supabase token');

        // Decode token to check algorithm
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || !decoded.header) {
          throw new Error('Invalid token format');
        }

        log.debug('Token decoded', {
          algorithm: decoded.header.alg,
          kid: decoded.header.kid,
          email: decoded.payload?.email
        });

        let payload;

        // Handle ES256 (asymmetric) tokens - modern Supabase default
        if (decoded.header.alg === 'ES256') {
          log.debug('Using ES256 verification via JWKS');
          const signingKey = await getSigningKey(decoded.header);
          if (!signingKey) {
            throw new Error('Unable to get signing key');
          }
          payload = jwt.verify(token, signingKey, { algorithms: ['ES256'] });
          log.debug('ES256 token verified successfully');
        }
        // Handle HS256 (symmetric) tokens - legacy Supabase or service_role keys
        else if (decoded.header.alg === 'HS256' && config.auth.supabaseJwtSecret) {
          log.debug('Using HS256 verification with JWT secret');
          payload = jwt.verify(token, config.auth.supabaseJwtSecret, { algorithms: ['HS256'] });
          log.debug('HS256 token verified successfully');
        }
        else {
          throw new Error('Unsupported token algorithm: ' + decoded.header.alg);
        }

        const user = await ensureLocalUserFromToken(payload);
        if (user) {
          // Successful auth is routine on every single request - not troubleshooting signal.
          // Failures (below, "Token verification failed") stay visible.
          log.debug('User authenticated successfully', { userId: user.id, email: user.email, role: user.role });
          req.user = user;
          req.isAuthenticated = () => true;
          if (req.app?.locals?.startServices) {
            await req.app.locals.startServices();
          }
        } else {
          log.warn('Token verified but user not found/created');
        }
      } catch (err) {
        log.warn('Token verification failed', { error: err.message, stack: err.stack });
        // invalid token, ignore and continue without auth
      }
    }
    next();
  } catch (err) {
    log.error('optionalAuth failed', { error: err.message });
    next();
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }

  // Block authenticated users without a role until access is granted
  if (!req.user.is_admin && !req.user.role) {
    const err = new ForbiddenError('Access pending: role not assigned');
    err.code = 'ACCESS_PENDING';
    throw err;
  }

  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  if (req.user.is_admin) {
    return next();
  }
  throw new ForbiddenError('Admin access required');
}

export function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.is_admin) {
      return next();
    }
    const perms = req.user.permissions || [];
    if (!perms.includes(permissionKey)) {
      throw new ForbiddenError('Insufficient permissions');
    }
    next();
  };
}

export async function getUserWithRole(userId) {
  return attachRoleAndPermissions(userId);
}

export default {
  configureSession,
  optionalAuth,
  requireAuth,
  requireAdmin,
  requirePermission,
  getUserWithRole,
  hashPassword,
  verifyPassword,
  signLocalToken,
};
