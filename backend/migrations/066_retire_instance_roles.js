/**
 * Migration 066: Retire the instance role columns
 *
 * market_data_role (primary/secondary) - the market-data pool is now only the instances with
 * "Use this instance for market data" (market_data_enabled) ticked. Any instance that held a role
 * gets that box ticked first, so the same accounts keep supplying quotes.
 *
 * is_primary_admin, is_secondary_admin, websocket_role - never read by anything.
 */

export const version = '066';
export const name = 'retire_instance_roles';

const COLUMNS = ['market_data_role', 'is_primary_admin', 'is_secondary_admin', 'websocket_role'];

export async function up(db) {
  const existing = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name);
  if (existing.includes('market_data_role')) {
    await db.run("UPDATE instances SET market_data_enabled = 1 WHERE market_data_role IN ('primary', 'secondary')");
  }
  await db.run('DROP INDEX IF EXISTS idx_instances_is_primary_admin');
  await db.run('DROP INDEX IF EXISTS idx_instances_is_secondary_admin');
  for (const column of COLUMNS) {
    if (existing.includes(column)) await db.run(`ALTER TABLE instances DROP COLUMN ${column}`);
  }
}

export async function down() {
  // Nothing to restore: no code reads these columns.
}
