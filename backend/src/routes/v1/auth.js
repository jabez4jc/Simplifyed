/**
 * Local email/password authentication (bootstrap admin, login, change password)
 */

import express from 'express';
import db from '../../core/database.js';
import { log } from '../../core/logger.js';
import {
  requireAuth,
  hashPassword,
  verifyPassword,
  signLocalToken,
  getUserWithRole,
} from '../../middleware/auth.js';

const router = express.Router();

/**
 * Login throttle.
 *
 * /login was the one unauthenticated endpoint that accepts a guess, and nothing anywhere in the
 * app rate-limits HTTP requests, so password guessing was bounded only by bcrypt's ~100ms - a few
 * hundred thousand attempts a day against a single admin account that fronts live broker
 * credentials.
 *
 * Keyed on IP+email so one attacker cannot lock out the real operator from a different address,
 * and so spraying many emails from one IP still trips the counter per target.
 *
 * ponytail: in-memory, single-process - resets on restart and does not span replicas. This app is
 * a single Node process with a SQLite database; if it ever runs multiple, move the counter into
 * the database or put a rate limiter in front.
 */
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginFails = new Map(); // `ip|email` -> { count, until }

function loginKey(req, email) {
  return `${req.ip}|${String(email || '').toLowerCase()}`;
}

function loginLockedUntil(key) {
  const entry = loginFails.get(key);
  if (!entry) return 0;
  if (entry.until && entry.until <= Date.now()) {
    loginFails.delete(key);
    return 0;
  }
  return entry.until || 0;
}

function recordLoginFailure(key) {
  // Drop expired entries opportunistically so a spray across many addresses cannot grow this
  // map without bound.
  if (loginFails.size > 1000) {
    const now = Date.now();
    for (const [k, v] of loginFails) {
      if (!v.until || v.until <= now) loginFails.delete(k);
    }
  }
  const entry = loginFails.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILS) {
    entry.until = Date.now() + LOGIN_LOCKOUT_MS;
    entry.count = 0;
  }
  loginFails.set(key, entry);
}

// Bootstrap the first admin account. Only works while no users exist yet - once any user
// exists this route is closed permanently, and further accounts are created by an admin via
// Settings > Access Control (rbac.service.js). Note install.sh creates the admin account
// itself, so on a scripted install this route is already closed by first boot.
router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({
        status: 'error',
        message: 'email and a password of at least 8 characters are required',
      });
    }

    const { count } = await db.get('SELECT COUNT(*) as count FROM users');
    if (count > 0) {
      return res.status(403).json({
        status: 'error',
        message: 'Registration is closed - an account already exists. Ask an admin to assign you a role.',
      });
    }

    const passwordHash = await hashPassword(password);
    const result = await db.run(
      'INSERT INTO users (email, is_admin, password_hash) VALUES (?, 1, ?)',
      [email.toLowerCase(), passwordHash]
    );

    const adminRole = await db.get('SELECT id FROM roles WHERE name = ?', ['Admin']);
    if (adminRole?.id) {
      await db.run('INSERT OR REPLACE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, NULL)', [
        result.lastID,
        adminRole.id,
      ]);
    }

    const user = await getUserWithRole(result.lastID);
    const token = signLocalToken(user);
    log.info('Bootstrap admin registered', { userId: user.id, email: user.email });
    res.json({ status: 'success', data: { token, user } });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ status: 'error', message: 'email and password are required' });
    }

    const key = loginKey(req, email);
    const lockedUntil = loginLockedUntil(key);
    if (lockedUntil) {
      const retryAfter = Math.ceil((lockedUntil - Date.now()) / 1000);
      res.set('Retry-After', String(retryAfter));
      log.warn('Login blocked - too many failed attempts', { email: String(email).toLowerCase() });
      return res.status(429).json({
        status: 'error',
        message: `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      });
    }

    const row = await db.get('SELECT id, password_hash FROM users WHERE email = ?', [email.toLowerCase()]);
    const ok = row && (await verifyPassword(password, row.password_hash));
    if (!ok) {
      recordLoginFailure(key);
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }
    loginFails.delete(key);

    const user = await getUserWithRole(row.id);
    const token = signLocalToken(user);
    res.json({ status: 'success', data: { token, user } });
  } catch (error) {
    next(error);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ status: 'error', message: 'newPassword must be at least 8 characters' });
    }

    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (row.password_hash) {
      const ok = await verifyPassword(currentPassword || '', row.password_hash);
      if (!ok) {
        return res.status(401).json({ status: 'error', message: 'Current password is incorrect' });
      }
    }

    const newHash = await hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    res.json({ status: 'success', message: 'Password updated' });
  } catch (error) {
    next(error);
  }
});

export default router;
