/**
 * Migration 082: instances.whatsapp_phone
 *
 * The instance owner's WhatsApp number (digits with country code, e.g. 919876543210). The 09:00
 * IST login reminder messages it when the instance is unreachable - usually because the owner has
 * not logged in to OpenAlgo to generate the day's broker token. NULL means no reminder.
 */

export const version = '082';
export const name = 'instance_whatsapp_phone';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name);
  if (!cols.includes('whatsapp_phone')) {
    await db.run('ALTER TABLE instances ADD COLUMN whatsapp_phone TEXT');
  }
}

export async function down(db) {
  await db.run('ALTER TABLE instances DROP COLUMN whatsapp_phone');
}
