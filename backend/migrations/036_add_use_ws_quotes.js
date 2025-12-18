/**
 * Add use_ws_quotes flag to instances to explicitly opt-in to broker WebSocket quotes/LTP.
 */

export const version = '036';
export const name = 'add_use_ws_quotes';

export async function up(db) {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN use_ws_quotes INTEGER DEFAULT 0
  `);
}

export async function down(db) {
  // SQLite cannot drop columns easily; noop to keep schema stable
  return;
}
