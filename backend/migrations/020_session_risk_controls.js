/**
 * Migration 020 - Add session risk controls and P&L tracking fields
 */

export const up = async (db) => {
  // Add new columns to instances table
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_target_profit REAL DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_max_loss REAL DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_baseline_total_pnl REAL DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_baseline_at TEXT DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_pnl REAL DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN last_live_total_pnl REAL DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN last_live_total_pnl_at TEXT DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_cutoff_reason TEXT DEFAULT NULL
  `);
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_cutoff_at TEXT DEFAULT NULL
  `);

  // Seed default trading session windows (IST) if not already present
  await db.run(`
    INSERT OR IGNORE INTO application_settings (key, value, description, category, data_type, is_sensitive)
    VALUES (
      'trading_sessions',
      ?,
      'Trading session windows in IST (start/end HH:MM).',
      'trading',
      'json',
      0
    )
  `, [JSON.stringify([
    { label: 'Session 1', start: '09:00', end: '11:30' },
    { label: 'Session 2', start: '12:30', end: '15:10' },
    { label: 'Session 3', start: '15:45', end: '19:00' },
    { label: 'Session 4', start: '20:30', end: '22:45' },
  ])]);
};

export const down = async (db) => {
  // SQLite does not support DROP COLUMN directly; skipping down migration for simplicity
  console.warn('Down migration 020 not implemented (non-destructive columns added).');
};
