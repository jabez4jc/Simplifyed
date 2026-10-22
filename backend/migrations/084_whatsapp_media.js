/**
 * Migration 084: whatsapp_messages.media
 *
 * Attachments of a message, as JSON: [{ file, name, mime, size }]. `file` is the stored file's
 * name inside the WhatsApp media folder (beside the database); it is deleted once no message
 * refers to it.
 */

export const version = '084';
export const name = 'whatsapp_media';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(whatsapp_messages)')).map((c) => c.name);
  if (!cols.includes('media')) {
    await db.run('ALTER TABLE whatsapp_messages ADD COLUMN media TEXT');
  }
}

export async function down(db) {
  await db.run('ALTER TABLE whatsapp_messages DROP COLUMN media');
}
