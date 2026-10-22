/**
 * Retention: the 6-hourly prune job (server.js). Each table keeps a fixed window (audit P3-1).
 */

import fs from 'fs';
import path from 'path';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { MEDIA_DIR } from './whatsapp.service.js';

const WINDOWS = [
  ['audit_logs', 'created_at', 7, ''],
  ['candles', 'fetched_at', 30, ''],
  ['risk_events', 'created_at', 30, ''],
  ['notifications', 'created_at', 30, 'AND read = 1'],
  ['quick_orders', 'created_at', 90, ''],
  ['watchlist_orders', 'placed_at', 90, ''],
  ['whatsapp_messages', 'created_at', 90, "AND status != 'queued'"],
];

export async function pruneOldRows() {
  for (const [table, column, days, extra] of WINDOWS) {
    try {
      const { changes } = await db.run(
        `DELETE FROM ${table} WHERE ${column} < datetime('now', ?) ${extra}`,
        [`-${days} days`]
      );
      if (changes) log.info('Retention pruned', { table, rows: changes, days });
    } catch (err) {
      log.warn('Retention prune failed', { table, error: err.message });
    }
  }
  try {
    await pruneWhatsAppPerInstance();
  } catch (err) {
    log.warn('Retention prune failed', { table: 'whatsapp_messages', error: err.message });
  }
}

/**
 * WhatsApp history: on top of the 90-day window above, keep the newest WHATSAPP_PER_INSTANCE
 * messages of each instance. A message about several instances stays while it is among the newest
 * of any of them; messages about no instance (admin-only alerts) count as one group of their own.
 */
export const WHATSAPP_PER_INSTANCE = 300;

async function pruneWhatsAppPerInstance() {
  const rows = await db.all("SELECT id, instance_ids FROM whatsapp_messages WHERE status != 'queued' ORDER BY id DESC");
  const seen = new Map();
  const drop = [];
  for (const { id, instance_ids: ids } of rows) {
    let keep = false;
    for (const key of ids ? ids.split(',').filter(Boolean) : ['none']) {
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n <= WHATSAPP_PER_INSTANCE) keep = true;
    }
    if (!keep) drop.push(id);
  }
  for (let i = 0; i < drop.length; i += 500) {
    const chunk = drop.slice(i, i + 500);
    await db.run(`DELETE FROM whatsapp_messages WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
  }
  if (drop.length) log.info('Retention pruned', { table: 'whatsapp_messages', rows: drop.length, perInstance: WHATSAPP_PER_INSTANCE });
  await pruneWhatsAppMedia();
}

/** Delete attachment files no message refers to any more (an hour's grace for a send in progress). */
async function pruneWhatsAppMedia() {
  let names;
  try {
    names = await fs.promises.readdir(MEDIA_DIR);
  } catch {
    return; // nothing uploaded yet
  }
  const used = new Set();
  for (const { media } of await db.all('SELECT media FROM whatsapp_messages WHERE media IS NOT NULL')) {
    for (const m of JSON.parse(media)) used.add(m.file);
  }
  let removed = 0;
  for (const name of names) {
    if (used.has(name)) continue;
    const file = path.join(MEDIA_DIR, name);
    const { mtimeMs } = await fs.promises.stat(file);
    if (Date.now() - mtimeMs < 60 * 60 * 1000) continue;
    await fs.promises.rm(file, { force: true });
    removed += 1;
  }
  if (removed) log.info('Retention pruned', { table: 'whatsapp media files', rows: removed });
}
