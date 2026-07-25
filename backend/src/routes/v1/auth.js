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

    const row = await db.get('SELECT id, password_hash FROM users WHERE email = ?', [email.toLowerCase()]);
    const ok = row && (await verifyPassword(password, row.password_hash));
    if (!ok) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }

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
