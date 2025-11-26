/**
 * Migration 029: Role-Based Access Control (RBAC)
 * - roles: list of roles (Admin, Trader, Monitor)
 * - permissions: fine-grained actions
 * - role_permissions: mapping role -> permissions
 * - user_roles: single-role assignment per user
 * - audit_logs: records sensitive actions
 */

export const version = '029';
export const name = 'add_rbac';

const PERMISSIONS = [
  // Settings
  { key: 'settings.manage', description: 'Manage all application settings' },
  { key: 'settings.instruments.refresh', description: 'Refresh instruments cache' },

  // Instances
  { key: 'instances.add', description: 'Add instances' },
  { key: 'instances.edit', description: 'Edit instances' },
  { key: 'instances.delete', description: 'Delete instances' },
  { key: 'instances.toggle_mode', description: 'Toggle live/analyzer mode' },

  // Watchlists & symbols
  { key: 'watchlists.manage', description: 'Create/update/delete watchlists' },
  { key: 'watchlists.symbols.manage', description: 'Add/update/delete watchlist symbols' },
  { key: 'watchlists.instances.manage', description: 'Assign/unassign instances to watchlists' },
  { key: 'watchlists.status', description: 'Activate/deactivate watchlists' },
  { key: 'orders.place', description: 'Place/modify orders from watchlist' },

  // Orders & positions
  { key: 'orders.cancel', description: 'Cancel individual orders' },
  { key: 'orders.cancel_all', description: 'Cancel all open/pending orders' },
  { key: 'positions.close', description: 'Close individual positions' },
  { key: 'positions.close_all', description: 'Close all open positions' },

  // Market data controls
  { key: 'marketdata.pause_resume', description: 'Pause/resume market data polling' },

  // RBAC admin
  { key: 'rbac.manage_roles', description: 'Manage roles and permissions' },
  { key: 'rbac.assign_roles', description: 'Assign roles to users' },
];

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL UNIQUE,
      role_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  // Seed roles
  const roleMap = new Map();
  const roles = [
    { name: 'Admin', description: 'Full access' },
    { name: 'Trader', description: 'Trading access without settings' },
    { name: 'Monitor', description: 'Read + limited actions' },
  ];

  for (const role of roles) {
    await db.run(
      `INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)`,
      [role.name, role.description]
    );
    const row = await db.get(`SELECT id FROM roles WHERE name = ?`, [role.name]);
    roleMap.set(role.name, row.id);
  }

  // Seed permissions
  const permMap = new Map();
  for (const perm of PERMISSIONS) {
    await db.run(
      `INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)`,
      [perm.key, perm.description]
    );
    const row = await db.get(`SELECT id FROM permissions WHERE key = ?`, [perm.key]);
    permMap.set(perm.key, row.id);
  }

  const assignPerms = async (roleName, keys) => {
    const roleId = roleMap.get(roleName);
    if (!roleId) return;
    for (const key of keys) {
      const permId = permMap.get(key);
      if (!permId) continue;
      await db.run(
        `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
        [roleId, permId]
      );
    }
  };

  // Admin: all permissions
  await assignPerms('Admin', PERMISSIONS.map(p => p.key));

  // Trader permissions
  await assignPerms('Trader', [
    'instances.edit',
    'instances.toggle_mode',
    'watchlists.manage',
    'watchlists.symbols.manage',
    'watchlists.instances.manage',
    'watchlists.status',
    'orders.place',
    'orders.cancel',
    'orders.cancel_all',
    'positions.close',
    'positions.close_all',
    'marketdata.pause_resume',
    'settings.instruments.refresh',
  ]);

  // Monitor permissions
  await assignPerms('Monitor', [
    'instances.toggle_mode',
    'watchlists.instances.manage',
    'watchlists.status',
    // No symbol/order placement
    'orders.cancel',
    'orders.cancel_all',
    'positions.close',
    'positions.close_all',
    'marketdata.pause_resume',
    'settings.instruments.refresh',
  ]);
}

export async function down(db) {
  await db.run(`DROP TABLE IF EXISTS audit_logs`);
  await db.run(`DROP TABLE IF EXISTS user_roles`);
  await db.run(`DROP TABLE IF EXISTS role_permissions`);
  await db.run(`DROP TABLE IF EXISTS permissions`);
  await db.run(`DROP TABLE IF EXISTS roles`);
}
