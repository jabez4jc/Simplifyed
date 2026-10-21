/**
 * Operator notifications (the Notifications page). One explicit call per meaningful event -
 * futures roll, kill switch, exit level fired, session cutoff, max-loss cap, unhealthy
 * instance with open positions. Never throws: a failed notice must not break the caller.
 *
 * A call tagged with `alert` (a whatsapp_templates alert key) and `instanceIds` is also sent as a
 * WhatsApp alert, if that alert is switched on - see whatsapp-alerts.service.js.
 */
import db from '../core/database.js';
import { log } from '../core/logger.js';

export async function notify(type, message, { severity = 'warn', alert = null, instanceIds = [], alertVars = {}, ...meta } = {}) {
  const extra = Object.entries(meta).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`);
  const body = (extra.length ? `${message} | ${extra.join(' ')}` : message).slice(0, 500);
  try {
    await db.run('INSERT INTO notifications (title, body, severity) VALUES (?, ?, ?)', [type, body, severity]);
  } catch (err) {
    log.warn('notify_failed', { type, error: err.message });
  }
  if (alert) {
    try {
      // Imported lazily: the alert path reaches the outbox, which itself notifies on failure.
      const { dispatchAlert } = await import('./whatsapp-alerts.service.js');
      await dispatchAlert(alert, { instanceIds, detail: message, vars: alertVars });
    } catch (err) {
      log.warn('whatsapp_alert_failed', { alert, error: err.message });
    }
  }
}
