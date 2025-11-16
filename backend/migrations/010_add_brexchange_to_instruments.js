/**
 * Migration 010: Add brexchange to instruments
 * Adds brexchange (broker exchange) field to instruments table
 */

export const version = '010';
export const name = 'add_brexchange_to_instruments';

export async function up(db) {
  console.log('Running migration 010: Add brexchange to instruments');

  // Check if column already exists
  const columns = await db.all(`PRAGMA table_info(instruments)`);
  const brexchangeExists = columns.some(col => col.name === 'brexchange');

  if (!brexchangeExists) {
    // Add brexchange column
    await db.run(`
      ALTER TABLE instruments
      ADD COLUMN brexchange TEXT
    `);
    console.log('  ✅ Added brexchange column to instruments table');
  } else {
    console.log('  ⊙ brexchange column already exists (skipping)');
  }
}

export async function down(db) {
  console.log('Rolling back migration 010: Remove brexchange from instruments');

  // SQLite doesn't support DROP COLUMN, so we'd need to recreate the table
  // For now, just document that this column was added
  console.log('  ⚠️  SQLite does not support DROP COLUMN - column will remain but be unused');
}
