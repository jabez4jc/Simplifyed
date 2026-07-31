import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../core/database.js';
import { config, isTestMode } from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

const LOCAL_TOKEN_TTL = '7d';

/**
 * True when the app is served over TLS, per BASE_URL. Exported so server.js's clearCookie call
 * uses the identical value - a Secure mismatch between set and clear leaves the cookie behind.
 */
export function isSecureBaseUrl() {
  return String(config.baseUrl || '').toLowerCase().startsWith('https:');
}

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

// Session configuration with persistent SQLite store
export function configureSession() {
  const SQLiteStore = connectSqlite3(session);
  const sessionConfig = {
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // Derived from the actual scheme, not from NODE_ENV. What makes a Secure cookie correct
      // is being served over TLS, which BASE_URL already states exactly; NODE_ENV only
      // correlates with it, and defaults to 'development' when unset - so a TLS deployment
      // missing that variable would have silently sent session cookies in the clear.
      secure: isSecureBaseUrl(),
      // Must match the options POST /auth/logout passes to res.clearCookie (server.js), or the
      // browser treats it as a different cookie and the session cookie survives logout.
      sameSite: 'lax',
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
  // Deliberately not `SELECT *` - this return value ends up as req.user and gets serialized
  // straight into API responses (e.g. the /login, /register data.user field), so password_hash
  // must never be selected here. Password verification uses its own separate query in
  // routes/v1/auth.js, not this helper.
  const user = await db.get(
    'SELECT id, email, is_admin, created_at FROM users WHERE id = ?',
    [userId]
  );
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

// Optional auth: attaches req.user from a verified local bearer JWT (see public/login.html and
// routes/v1/auth.js), or from test mode when enabled. The Express session (configureSession) is
// unrelated to this - it only backs WS gateway cookie auth.
export async function optionalAuth(req, res, next) {
  try {
    if (isTestMode()) {
      req.user = {
        id: 1,
        email: 'test@example.com',
        is_admin: 1,
        role: 'Admin',
        permissions: [],
      };
      req.isAuthenticated = () => true;
      if (req.app?.locals?.startServices) {
        // Fire-and-forget: these are long-running background loops (market data/auto-exit/order
        // polling against real broker instances), not something this specific request's response
        // needs to wait on. Awaiting it here meant the very first authenticated request after a
        // server restart blocked on however long broker connection/startup took. The guard in
        // startBackgroundServices() (server.js) is already race-safe for concurrent callers, and
        // it logs its own failure internally, so just swallow the rejection here.
        req.app.locals.startServices().catch(() => {});
      }
      return next();
    }

    // Bearer token: locally-issued JWT (email/password login)
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
            // Fire-and-forget - see the identical comment in the test-mode branch above.
            req.app.locals.startServices().catch(() => {});
          }
          return next();
        }
        log.warn('Token verified but user not found/created');
      } catch (err) {
        log.warn('Token verification failed', { error: err.message });
        // invalid/expired token, ignore and continue without auth
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

/**
 * Verify a locally-issued Bearer JWT for the WS gateway's connection-upgrade auth.
 *
 * No DB round-trip (unlike optionalAuth) - the gateway only needs to know the token is genuine
 * and unexpired before it starts streaming to that socket, not the user's permission set.
 * Deliberately the SAME secret and algorithm optionalAuth verifies REST requests with: the
 * gateway used to check an express-session cookie instead, which nothing in this app ever
 * issues (saveUninitialized is false and no route writes to req.session), so the WS connection
 * was rejected on every single attempt, not merely sometimes.
 */
export function verifyLocalToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
  } catch (_) {
    return null;
  }
}

export default {
  configureSession,
  optionalAuth,
  requireAuth,
  requireAdmin,
  requirePermission,
  getUserWithRole,
  verifyLocalToken,
  hashPassword,
  verifyPassword,
  signLocalToken,
};
