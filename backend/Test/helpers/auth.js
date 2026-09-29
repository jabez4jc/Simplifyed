/**
 * Real users, real roles, real JWTs.
 *
 * Deliberately NOT ENABLE_TEST_MODE: that bypass hands every request a synthetic admin with
 * `permissions: []`, which means a permission test written against it proves nothing about the
 * permission system. These fixtures go through attachRoleAndPermissions the same way a browser
 * session does, so a 403 in a test is a 403 in production.
 */

import db from '../../src/core/database.js';
import { hashPassword, signLocalToken } from '../../src/middleware/auth.js';

export const ROLE = { ADMIN: 1, TRADER: 2, MONITOR: 3 };

let seq = 0;

/**
 * Create a user, optionally assign a seeded role, and return it with a signed bearer token.
 *
 * @param {object} opts
 * @param {number|null} opts.roleId    One of ROLE.*, or null for a user with no role at all
 *                                     (requireAuth rejects those with ACCESS_PENDING - that is
 *                                     a case worth testing).
 * @param {boolean} opts.isAdmin       is_admin short-circuits every permission check.
 * @param {string} opts.password       Only matters for tests that hit POST /auth/login.
 */
export async function createUser({ roleId = null, isAdmin = false, password = 'test-password-1' } = {}) {
  seq += 1;
  const email = `user-${process.pid}-${seq}-${Date.now()}@example.test`;
  const hash = await hashPassword(password);

  const { lastID } = await db.run(
    'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)',
    [email, hash, isAdmin ? 1 : 0]
  );

  if (roleId !== null) {
    await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [lastID, roleId]);
  }

  return { id: lastID, email, password, isAdmin, roleId, token: signLocalToken({ id: lastID, email }) };
}

export const asAdmin = () => createUser({ roleId: ROLE.ADMIN, isAdmin: true });
export const asTrader = () => createUser({ roleId: ROLE.TRADER });
export const asMonitor = () => createUser({ roleId: ROLE.MONITOR });
export const asRoleless = () => createUser({ roleId: null });

/**
 * A user holding exactly the permissions listed and nothing else.
 *
 * Needed because the three seeded roles are coarse: proving a route is gated on
 * `instances.edit` specifically means testing a user who has every OTHER permission but that
 * one, which no seeded role gives you.
 */
export async function withPermissions(keys) {
  seq += 1;
  const roleName = `test-role-${process.pid}-${seq}-${Date.now()}`;
  const { lastID: roleId } = await db.run(
    'INSERT INTO roles (name, description) VALUES (?, ?)',
    [roleName, 'ephemeral test role']
  );

  for (const key of keys) {
    const perm = await db.get('SELECT id FROM permissions WHERE key = ?', [key]);
    if (!perm) throw new Error(`No such permission: ${key} - check the seed in 000_initial_schema.js`);
    await db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, perm.id]);
  }

  return createUser({ roleId });
}

/** All permissions except the ones named - the "everything but X" user a gate test needs. */
export async function withPermissionsExcept(excluded) {
  const all = await db.all('SELECT key FROM permissions');
  const drop = new Set(excluded);
  return withPermissions(all.map((p) => p.key).filter((k) => !drop.has(k)));
}

/** Attach a fixture's token to a supertest request: `bearer(request(app).get('/x'), user)`. */
export const bearer = (req, user) => req.set('Authorization', `Bearer ${user.token}`);
