/**
 * Migration 073: repair the instruments FTS index and reclaim its space (audit H12)
 *
 * instruments_fts is an external-content FTS5 table. The AFTER DELETE trigger below removed rows
 * with a plain DELETE, which an external-content table cannot undo (the old values are already
 * gone from `instruments`), and every refresh also hand-edited the index. The index (and its
 * docsize shadow table) grew to ~6,000,000 entries for ~136,000 instruments and took ~237 MB of a
 * 367 MB database.
 *
 * Instruments are now replaced per exchange in one transaction and the index is rebuilt once
 * afterwards (`INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')`), so the per-row
 * triggers are dropped. Expiry is also normalised to ISO (YYYY-MM-DD): crypto rows were stored as
 * DD-MMM-YY by an older importer.
 *
 * VACUUM cannot run inside a transaction, and the migration runner does not open one around up().
 * If migrations are ever wrapped in a transaction, move the VACUUM to a post-migration step.
 */

export const version = '073';
export const name = 'instruments_fts_rebuild';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export async function up(db) {
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_insert');
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_update');
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_delete');

  const month = MONTHS.map((m, i) => `WHEN '${m}' THEN '${String(i + 1).padStart(2, '0')}'`).join(' ');
  await db.run(`
    UPDATE instruments
    SET expiry = '20' || substr(expiry, 8, 2) || '-' || CASE substr(expiry, 4, 3) ${month} END || '-' || substr(expiry, 1, 2)
    WHERE expiry GLOB '[0-9][0-9]-[A-Z][A-Z][A-Z]-[0-9][0-9]'
  `);

  await db.run("INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')");
  await db.run('VACUUM');
}

export async function down() {
  // Nothing to restore: the triggers were the bug, and the rebuilt index is equivalent.
}
