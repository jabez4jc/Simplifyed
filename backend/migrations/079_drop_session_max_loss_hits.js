/**
 * Migration 079: drop instances.session_max_loss_hits(_date) (audit D24)
 *
 * The max-loss hit counter was deleted in Phase 2; nothing reads or writes these columns.
 */

export const version = '079';
export const name = 'drop_session_max_loss_hits';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name);
  for (const col of ['session_max_loss_hits', 'session_max_loss_hits_date']) {
    if (cols.includes(col)) await db.run(`ALTER TABLE instances DROP COLUMN ${col}`);
  }
}

export async function down() {
  // Nothing to restore: nothing reads or writes these columns any more.
}
