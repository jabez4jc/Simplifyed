/**
 * Migration 038: Add alert counters to watchlists
 * - alert_received_count: total alerts received via webhook
 * - alert_success_count: total alerts that had at least one downstream success
 */

export const version = '038';
export const name = 'add_watchlist_alert_counters';

async function columnExists(db, table, column) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

export async function up(db) {
  if (!(await columnExists(db, 'watchlists', 'alert_received_count'))) {
    await db.run(`ALTER TABLE watchlists ADD COLUMN alert_received_count INTEGER DEFAULT 0`);
  }
  if (!(await columnExists(db, 'watchlists', 'alert_success_count'))) {
    await db.run(`ALTER TABLE watchlists ADD COLUMN alert_success_count INTEGER DEFAULT 0`);
  }
}

export async function down(db) {
  // SQLite can't drop columns easily; leave columns in place on rollback.
}
