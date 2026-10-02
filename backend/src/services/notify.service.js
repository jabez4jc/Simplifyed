/**
 * Operator notifications (the Notifications page). One explicit call per meaningful event -
 * futures roll, kill switch, exit level fired, session cutoff, max-loss cap, unhealthy
 * instance with open positions. Never throws: a failed notice must not break the caller.
 */
import db from '../core/database.js';
import { log } from '../core/logger.js';

export async function notify(type, message, { severity = 'warn', ...meta } = {}) {
  const extra = Object.entries(meta).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`);
  const body = (extra.length ? `${message} | ${extra.join(' ')}` : message).slice(0, 500);
  try {
    await db.run('INSERT INTO notifications (title, body, severity) VALUES (?, ?, ?)', [type, body, severity]);
  } catch (err) {
    log.warn('notify_failed', { type, error: err.message });
  }
}
