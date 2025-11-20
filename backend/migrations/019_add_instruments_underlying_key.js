/**
 * Migration 019: Add underlying_key to instruments
 */

export const version = '019';
export const name = 'add_instruments_underlying_key';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

export async function up(db) {
  const exists = await columnExists(db, 'instruments', 'underlying_key');
  if (!exists) {
    await db.run(`
      ALTER TABLE instruments ADD COLUMN underlying_key TEXT
    `);
  }

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_underlying_key
    ON instruments(underlying_key)
  `);
}

export async function down() {
  console.warn('Rollback for migration 019 is not implemented (would require table rebuild)');
}
