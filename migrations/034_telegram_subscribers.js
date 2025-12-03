export const version = '034';
export const name = 'telegram_subscribers';

export async function up(db) {
  // Create subscribers table
  await db.run(`
    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      linking_code TEXT,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate any existing user_telegram_config data if present
  const table = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='user_telegram_config'");
  if (table) {
    const rows = await db.all('SELECT user_id, telegram_chat_id, telegram_username, linked_at, is_active FROM user_telegram_config WHERE telegram_chat_id IS NOT NULL');
    for (const r of rows) {
      try {
        await db.run(
          `INSERT OR IGNORE INTO telegram_subscribers (user_id, chat_id, username, linked_at, is_active)
           VALUES (?, ?, ?, ?, ?)`,
          [r.user_id, r.telegram_chat_id, r.telegram_username, r.linked_at, r.is_active]
        );
      } catch (err) {
        // ignore duplicate/constraint issues during migration
      }
    }
  }
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS telegram_subscribers');
}
