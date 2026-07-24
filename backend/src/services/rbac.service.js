import db from '../core/database.js';
import { ValidationError, ConflictError, NotFoundError } from '../core/errors.js';
import { hashPassword } from '../middleware/auth.js';

class RbacService {
  async listRoles() {
    const roles = await db.all(`SELECT * FROM roles ORDER BY name ASC`);
    const permissions = await db.all(`SELECT rp.role_id, p.key
                                      FROM role_permissions rp
                                      JOIN permissions p ON p.id = rp.permission_id`);
    const permByRole = permissions.reduce((acc, row) => {
      acc[row.role_id] = acc[row.role_id] || [];
      acc[row.role_id].push(row.key);
      return acc;
    }, {});
    return roles.map(r => ({
      ...r,
      permissions: permByRole[r.id] || [],
    }));
  }

  async listPermissions() {
    return db.all(`SELECT id, key, description FROM permissions ORDER BY key ASC`);
  }

  async listUsersWithRoles() {
    const rows = await db.all(`
      SELECT u.id, u.email, u.is_admin, r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      ORDER BY u.created_at ASC
    `);
    return rows;
  }

  async assignRole(userId, roleName, assignedBy) {
    const role = await db.get(`SELECT id FROM roles WHERE name = ?`, [roleName]);
    if (!role) {
      throw new ValidationError('Role not found');
    }
    await db.run(
      `INSERT OR REPLACE INTO user_roles (user_id, role_id, assigned_by)
       VALUES (?, ?, ?)`,
      [userId, role.id, assignedBy || null]
    );
  }

  async createUser(email, password, roleName, createdBy) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    const existing = await db.get(`SELECT id FROM users WHERE email = ?`, [normalizedEmail]);
    if (existing) {
      throw new ConflictError('A user with this email already exists');
    }

    const passwordHash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (email, is_admin, password_hash) VALUES (?, 0, ?)`,
      [normalizedEmail, passwordHash]
    );

    await this.assignRole(result.lastID, roleName, createdBy);

    return { id: result.lastID, email: normalizedEmail, role: roleName };
  }

  async resetPassword(userId, newPassword) {
    const passwordHash = await hashPassword(newPassword);
    const result = await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [
      passwordHash,
      userId,
    ]);
    if (!result.changes) {
      throw new NotFoundError('User');
    }
  }

  async setRolePermissions(roleName, permissionKeys = []) {
    const role = await db.get(`SELECT id FROM roles WHERE name = ?`, [roleName]);
    if (!role) {
      throw new ValidationError('Role not found');
    }
    const existingPerms = await db.all(`SELECT id, key FROM permissions WHERE key IN (${permissionKeys.map(() => '?').join(',') || "''"})`, permissionKeys);
    const permIds = new Set(existingPerms.map(p => p.id));

    await db.run(`DELETE FROM role_permissions WHERE role_id = ?`, [role.id]);
    for (const id of permIds) {
      await db.run(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
        [role.id, id]
      );
    }
  }
}

export default new RbacService();
