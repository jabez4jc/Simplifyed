/**
 * Migration 081: take watchlist and settings management away from the Monitor role
 *
 * Monitor is a watcher: it may cancel, close and flatten (cancel all, close all, toggle analyzer
 * mode, kill switch) but never open risk. 000 also granted it three management permissions that
 * contradict that: assigning instances to watchlists and activating watchlists both decide which
 * accounts a webhook alert trades, and the instruments refresh is a settings action.
 *
 * Seeded role rows only - a role an admin has since edited in Access Control is edited again
 * here. Grant them back there if a deployment wants Monitor to have them.
 */

export const version = '081';
export const name = 'monitor_role_limits';

const REVOKED = ['watchlists.instances.manage', 'watchlists.status', 'settings.instruments.refresh'];

export async function up(db) {
  await db.run(
    `DELETE FROM role_permissions
     WHERE role_id = (SELECT id FROM roles WHERE name = 'Monitor')
       AND permission_id IN (SELECT id FROM permissions WHERE key IN (${REVOKED.map(() => '?').join(',')}))`,
    REVOKED
  );
}

export async function down(db) {
  await db.run(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
     WHERE r.name = 'Monitor' AND p.key IN (${REVOKED.map(() => '?').join(',')})`,
    REVOKED
  );
}
