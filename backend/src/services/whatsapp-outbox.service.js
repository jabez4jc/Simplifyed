/**
 * WhatsApp outbox. Every message - typed on the Send tab, a login reminder, an alert - is a row in
 * whatsapp_messages, sent one at a time a few seconds apart (a burst of identical messages is what
 * gets a personal number restricted). Alerts jump the queue. A row ends 'sent' or 'failed' with
 * the error, and that table is the History tab.
 */
import db from '../core/database.js';
import { log } from '../core/logger.js';
import whatsappService from './whatsapp.service.js';
import { notify } from './notify.service.js';

export const PRIORITY = { normal: 0, alert: 10 };
const GAP_MIN_MS = 3000;
const GAP_MAX_MS = 6000;
// While WhatsApp is reconnecting, messages wait this long before they are failed - a reminder
// delivered hours late is worse than one reported as not sent.
const HOLD_MINUTES = 10;

class WhatsAppOutboxService {
  constructor() {
    this.running = null; // the drain promise while a drain is in progress
    this.gap = () => GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
  }

  /**
   * Queue messages. Each: { recipient: 'owner'|'admin', phone (owner only - the admin's is the
   * linked account, resolved at send time), instanceIds, templateKey, body, priority, sentBy,
   * media: [{ file, name, mime, size }] already stored in MEDIA_DIR }.
   * @returns {Promise<number[]>} ids of the queued rows
   */
  async enqueue(messages) {
    const ids = [];
    for (const m of messages) {
      const { lastID } = await db.run(
        `INSERT INTO whatsapp_messages (recipient, phone, instance_ids, template_key, body, priority, sent_by, media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.recipient,
          m.recipient === 'admin' ? null : m.phone,
          m.instanceIds?.length ? `,${m.instanceIds.join(',')},` : null,
          m.templateKey || null,
          m.body,
          m.priority ?? PRIORITY.normal,
          m.sentBy ?? null,
          m.media?.length ? JSON.stringify(m.media) : null,
        ]
      );
      ids.push(lastID);
    }
    if (ids.length) this.drain();
    return ids;
  }

  /** Send everything queued. Safe to call any time; concurrent calls share one run. */
  drain() {
    if (!this.running) {
      this.running = this._drain()
        .catch((err) => log.error('whatsapp_outbox_failed', err))
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  async _drain() {
    let first = true;
    for (;;) {
      if (whatsappService.getStatus().status !== 'open') {
        await this._failStale();
        return; // the rest are sent when the connection opens
      }
      const row = await db.get(
        "SELECT * FROM whatsapp_messages WHERE status = 'queued' ORDER BY priority DESC, id LIMIT 1"
      );
      if (!row) return;
      if (!first) await new Promise((r) => setTimeout(r, this.gap()));
      first = false;
      const phone = row.recipient === 'admin' ? whatsappService.phone() : row.phone;
      try {
        if (!phone) throw new Error('WhatsApp not connected');
        await whatsappService.sendMessage(phone, row.body, row.media ? JSON.parse(row.media) : []);
        await db.run("UPDATE whatsapp_messages SET status = 'sent', phone = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?", [phone, row.id]);
      } catch (err) {
        await db.run("UPDATE whatsapp_messages SET status = 'failed', phone = ?, error = ? WHERE id = ?", [phone, err.message, row.id]);
        log.warn('whatsapp_send_failed', { id: row.id, error: err.message });
        // An automated message that failed would otherwise go unnoticed - the admin did not press Send.
        if (!row.sent_by) {
          await notify('WhatsApp send failed', `${row.template_key || 'message'} to ${phone || row.recipient}: ${err.message}`, { severity: 'error' });
        }
      }
    }
  }

  async _failStale() {
    const stale = await db.all(
      "SELECT * FROM whatsapp_messages WHERE status = 'queued' AND created_at < datetime('now', ?)",
      [`-${HOLD_MINUTES} minutes`]
    );
    if (!stale.length) return;
    await db.run(
      `UPDATE whatsapp_messages SET status = 'failed', error = 'WhatsApp not connected' WHERE id IN (${stale.map(() => '?').join(',')})`,
      stale.map((r) => r.id)
    );
    await notify('WhatsApp send failed', `${stale.length} message(s) not sent: WhatsApp was not connected for ${HOLD_MINUTES} minutes`, { severity: 'error' });
  }

  /** Newest first; optionally only the messages about one instance. */
  history(limit = 300, instanceId = null) {
    const id = Number(instanceId);
    const byInstance = Number.isInteger(id) && id > 0;
    return db.all(
      `SELECT m.*, u.email AS sent_by_email FROM whatsapp_messages m
       LEFT JOIN users u ON u.id = m.sent_by
       ${byInstance ? 'WHERE m.instance_ids LIKE ?' : ''}
       ORDER BY m.id DESC LIMIT ?`,
      [...(byInstance ? [`%,${id},%`] : []), Math.min(Math.max(Number(limit) || 300, 1), 1000)]
    );
  }
}

export default new WhatsAppOutboxService();
