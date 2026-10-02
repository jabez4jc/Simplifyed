/**
 * Retention: the 6-hourly prune job (server.js). Each table keeps a fixed window (audit P3-1).
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';

const WINDOWS = [
  ['audit_logs', 'created_at', 7, ''],
  ['candles', 'fetched_at', 30, ''],
  ['risk_events', 'created_at', 30, ''],
  ['notifications', 'created_at', 30, 'AND read = 1'],
  ['quick_orders', 'created_at', 90, ''],
  ['watchlist_orders', 'placed_at', 90, ''],
];

export async function pruneOldRows() {
  for (const [table, column, days, extra] of WINDOWS) {
    try {
      const { changes } = await db.run(
        `DELETE FROM ${table} WHERE ${column} < datetime('now', ?) ${extra}`,
        [`-${days} days`]
      );
      if (changes) log.info('Retention pruned', { table, rows: changes, days });
    } catch (err) {
      log.warn('Retention prune failed', { table, error: err.message });
    }
  }
}
