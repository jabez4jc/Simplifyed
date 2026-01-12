/**
 * Migration 046: Idempotency Keys
 * - Adds idempotency_keys table for request de-duplication
 */

export const version = '046';
export const name = 'add_idempotency_keys';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      source TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      UNIQUE(request_id, source)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
    ON idempotency_keys(created_at)
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS idempotency_keys');
}
