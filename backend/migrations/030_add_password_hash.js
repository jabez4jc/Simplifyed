/**
 * Migration 030: Add password_hash to users
 */

export const version = '030';
export const name = 'add_password_hash';

export async function up(db) {
  await db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
}

export async function down(db) {
  // SQLite cannot drop column easily; leave as no-op
  return;
}
