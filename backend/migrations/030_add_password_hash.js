/**
 * Migration 030: Add password_hash to users
 */

export const version = '030';
export const name = 'add_password_hash';

export async function up(db) {
  const cols = await db.all(`PRAGMA table_info('users')`);
  const hasCol = cols.some((c) => c.name === 'password_hash');
  if (hasCol) {
    console.log('  ⏭️  password_hash already exists on users, skipping');
    return;
  }
  await db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
}

export async function down(db) {
  // SQLite cannot drop column easily; leave as no-op
  return;
}
