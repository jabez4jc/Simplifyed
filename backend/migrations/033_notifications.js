export const version = '033';
export const name = 'notifications';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      severity TEXT DEFAULT 'info',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read INTEGER DEFAULT 0
    )
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS notifications');
}
