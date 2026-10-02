/**
 * Migration 076: drop telegram_subscribers (audit F2)
 *
 * Per-user Telegram linking is gone; only TELEGRAM_DEFAULT_CHAT_ID receives messages.
 */

export const version = '076';
export const name = 'drop_telegram_subscribers';

export async function up(db) {
  await db.run('DROP TABLE IF EXISTS telegram_subscribers');
}

export async function down() {
  // Nothing to restore: nothing reads or writes this table any more.
}
