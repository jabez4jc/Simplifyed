/**
 * Migration 044: Daily P&L snapshots per instance + monitor.view permission
 */

export const version = '044';
export const name = 'add_daily_pnl_snapshots';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS daily_instance_pnl_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      total_pnl REAL NOT NULL DEFAULT 0,
      buy_trades INTEGER NOT NULL DEFAULT 0,
      sell_trades INTEGER NOT NULL DEFAULT 0,
      buy_value REAL NOT NULL DEFAULT 0,
      sell_value REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(instance_id, snapshot_date),
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_date
    ON daily_instance_pnl_snapshots (snapshot_date)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_instance_date
    ON daily_instance_pnl_snapshots (instance_id, snapshot_date)
  `);

  await db.run(
    `INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)`,
    ['monitor.view', 'View daily P&L snapshots']
  );

  const permRow = await db.get(`SELECT id FROM permissions WHERE key = ?`, ['monitor.view']);
  if (!permRow) return;

  const roleRows = await db.all(`SELECT id, name FROM roles WHERE name IN ('Admin', 'Monitor')`);
  for (const role of roleRows) {
    await db.run(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
      [role.id, permRow.id]
    );
  }
}

export async function down(db) {
  await db.run(`DROP TABLE IF EXISTS daily_instance_pnl_snapshots`);
  await db.run(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'monitor.view')`);
  await db.run(`DELETE FROM permissions WHERE key = 'monitor.view'`);
}
