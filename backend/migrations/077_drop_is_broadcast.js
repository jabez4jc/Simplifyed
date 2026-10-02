/**
 * Migration 077: drop watchlists.is_broadcast (audit F4)
 *
 * `type = 'broadcast'` is the single source. Any row flagged only by the old column is promoted
 * first so no broadcast watchlist silently turns into a standard one.
 */

export const version = '077';
export const name = 'drop_is_broadcast';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(watchlists)')).map((c) => c.name);
  if (!cols.includes('is_broadcast')) return;
  await db.run("UPDATE watchlists SET type = 'broadcast' WHERE is_broadcast = 1 AND type = 'standard'");
  await db.run('ALTER TABLE watchlists DROP COLUMN is_broadcast');
}

export async function down() {
  // Nothing to restore: nothing reads or writes this column any more.
}
