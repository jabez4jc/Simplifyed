/**
 * Migration 050: Page-level view permissions
 * - Adds view permissions for all main pages
 */

export const version = '050';
export const name = 'add_page_permissions';

const PAGE_PERMISSIONS = [
  { key: 'pages.dashboard.view', description: 'View Dashboard page' },
  { key: 'pages.instances.view', description: 'View Instances page' },
  { key: 'pages.watchlists.view', description: 'View Watchlists page' },
  { key: 'pages.orders.view', description: 'View Orders page' },
  { key: 'pages.trades.view', description: 'View Trades page' },
  { key: 'pages.positions.view', description: 'View Positions page' },
  { key: 'pages.daily_pnl.view', description: 'View Daily P&L snapshots' },
  { key: 'pages.settings.view', description: 'View Settings page' },
  { key: 'pages.notifications.view', description: 'View Notifications page' },
  { key: 'pages.notifications.edit', description: 'Manage Notifications (mark read)' },
  { key: 'pages.audit.view', description: 'View Audit Logs page' },
  { key: 'pages.api_playground.view', description: 'View API Playground page' },
];

async function roleIdFor(db, name) {
  const row = await db.get('SELECT id FROM roles WHERE name = ?', [name]);
  return row?.id || null;
}

async function permIdFor(db, key) {
  const row = await db.get('SELECT id FROM permissions WHERE key = ?', [key]);
  return row?.id || null;
}

export async function up(db) {
  for (const perm of PAGE_PERMISSIONS) {
    await db.run(
      'INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)',
      [perm.key, perm.description]
    );
  }

  const adminRoleId = await roleIdFor(db, 'Admin');
  const traderRoleId = await roleIdFor(db, 'Trader');
  const monitorRoleId = await roleIdFor(db, 'Monitor');

  const grant = async (roleId, keys = []) => {
    if (!roleId) return;
    for (const key of keys) {
      const permId = await permIdFor(db, key);
      if (!permId) continue;
      await db.run(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permId]
      );
    }
  };

  // Admin: all page permissions
  await grant(adminRoleId, PAGE_PERMISSIONS.map((p) => p.key));

  // Trader: view all pages except audit, API playground; can mark notifications read
  await grant(traderRoleId, [
    'pages.dashboard.view',
    'pages.instances.view',
    'pages.watchlists.view',
    'pages.orders.view',
    'pages.trades.view',
    'pages.positions.view',
    'pages.daily_pnl.view',
    'pages.settings.view',
    'pages.notifications.view',
    'pages.notifications.edit',
  ]);

  // Monitor: view operational pages; can mark notifications read
  await grant(monitorRoleId, [
    'pages.dashboard.view',
    'pages.instances.view',
    'pages.watchlists.view',
    'pages.orders.view',
    'pages.trades.view',
    'pages.positions.view',
    'pages.daily_pnl.view',
    'pages.notifications.view',
    'pages.notifications.edit',
  ]);
}

export async function down(_db) {
  // No-op; permissions are additive and safe to keep
}
