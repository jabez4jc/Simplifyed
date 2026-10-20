/**
 * Migration 080: users.password_changed_at
 *
 * Unix seconds of the last password reset. resolveTokenUser refuses a login token issued before
 * it, so a reset signs the user out of REST and the WS stream, not only future logins.
 */

export const version = '080';
export const name = 'password_changed_at';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
  if (!cols.includes('password_changed_at')) {
    await db.run('ALTER TABLE users ADD COLUMN password_changed_at INTEGER');
  }
}

export async function down(db) {
  await db.run('ALTER TABLE users DROP COLUMN password_changed_at');
}
