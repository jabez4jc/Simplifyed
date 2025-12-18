/**
 * Migration 037: Broadcast Watchlists
 * - Adds type/is_broadcast flags
 * - Adds webhook_slug for TradingView webhook routing
 */

export const version = '037';
export const name = 'add_broadcast_watchlists';

async function columnExists(db, table, column) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export async function up(db) {
  // watchlists.type (standard|broadcast)
  if (!(await columnExists(db, 'watchlists', 'type'))) {
    await db.run(`ALTER TABLE watchlists ADD COLUMN type TEXT DEFAULT 'standard'`);
  }

  // watchlists.is_broadcast (boolean flag for quick checks)
  if (!(await columnExists(db, 'watchlists', 'is_broadcast'))) {
    await db.run(`ALTER TABLE watchlists ADD COLUMN is_broadcast BOOLEAN DEFAULT 0`);
  }

  // watchlists.webhook_slug (unique slug to reference in webhook URLs)
  if (!(await columnExists(db, 'watchlists', 'webhook_slug'))) {
    await db.run(`ALTER TABLE watchlists ADD COLUMN webhook_slug TEXT`);
  }

  // Unique index on webhook_slug (allow NULL)
  await db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_webhook_slug
     ON watchlists(webhook_slug)
     WHERE webhook_slug IS NOT NULL`
  );
}

export async function down(db) {
  // SQLite cannot drop columns easily; best-effort cleanup by dropping index
  await db.run('DROP INDEX IF EXISTS idx_watchlists_webhook_slug');
}
