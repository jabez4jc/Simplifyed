import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import db from '../core/database.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

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
  if (!externalId) return null;

  let user = await db.get('SELECT * FROM users WHERE email = ?', [email || externalId]);
  if (!user) {
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
  }
  return attachRoleAndPermissions(user.id);
}

// Optional auth: attaches req.user if session exists or test mode enabled
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

    // Bearer token from Supabase
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token && config.auth.supabaseJwtSecret) {
      try {
        // Validate Supabase JWT with signing secret; skip aud/iss enforcement for compatibility
        const payload = jwt.verify(token, config.auth.supabaseJwtSecret);
        const user = await ensureLocalUserFromToken(payload);
        if (user) {
          req.user = user;
          req.isAuthenticated = () => true;
          if (req.app?.locals?.startServices) {
            await req.app.locals.startServices();
          }
        }
      } catch (err) {
        // invalid token, ignore
      }
    }
    next();
  } catch (err) {
    log.error('optionalAuth failed', { error: err.message });
    next();
  }
}

export function requireAuth(req, res, next) {
  if (req.user) {
    return next();
  }
  throw new UnauthorizedError('Authentication required');
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
};
