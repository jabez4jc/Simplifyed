/**
 * Migration 074: drop quote_snapshots (audit H13)
 *
 * Every WebSocket tick upserted a row here (the dedupe check could never match), and the startup
 * hydration restored one stale symbol per instance. Quotes live in the feed's in-memory caches;
 * GET /snapshots/quotes now reads them.
 */

export const version = '074';
export const name = 'drop_quote_snapshots';

export async function up(db) {
  await db.run('DROP TABLE IF EXISTS quote_snapshots');
}

export async function down() {
  // Nothing to restore: nothing reads or writes this table any more.
}
