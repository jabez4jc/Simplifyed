import bcrypt from 'bcryptjs';
import db from '../core/database.js';
import { ValidationError, UnauthorizedError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { getUserWithRole } from '../middleware/auth.js';

const SALT_ROUNDS = 10;

export async function createUser({ email, password }) {
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (existing) {
    throw new ValidationError('User already exists');
  }

  const countRow = await db.get('SELECT COUNT(*) as count FROM users');
  const isFirstUser = (countRow?.count || 0) === 0;
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await db.run(
    'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)',
    [normalizedEmail, passwordHash, isFirstUser ? 1 : 0]
  );

  const userId = result.lastID;
  // Assign Admin role for first user if roles table has Admin
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

  log.info('User created', { email: normalizedEmail, is_first_user: isFirstUser });
  return getUserWithRole(userId);
}

export async function authenticate({ email, password }) {
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user || !user.password_hash) {
    throw new UnauthorizedError('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    throw new UnauthorizedError('Invalid credentials');
  }
  return getUserWithRole(user.id);
}

export async function clearPassword(userId) {
  await db.run('UPDATE users SET password_hash = NULL WHERE id = ?', [userId]);
}

export default {
  createUser,
  authenticate,
  clearPassword,
};
