/**
 * Migration 041: Enable broker WS quotes for existing instances
 */

export const version = '041';
export const name = 'enable_ws_quotes_instances';

export async function up(db) {
  console.log('  ℹ️  Enabling use_ws_quotes for existing instances');
  await db.run('UPDATE instances SET use_ws_quotes = 1 WHERE use_ws_quotes IS NULL OR use_ws_quotes = 0');
  console.log('  ✅ use_ws_quotes enabled for existing instances');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 041 is not implemented (requires manual update)');
}
