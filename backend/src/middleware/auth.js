import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
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
