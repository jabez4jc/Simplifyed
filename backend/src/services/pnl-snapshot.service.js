/**
 * Daily P&L Snapshot Service
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { toISTDate } from '../utils/time.js';

class PnlSnapshotService {
  _formatDateKey(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async incrementSignalCounts(instanceId, counts = {}, snapshotDate = null) {
    const {
      webhook_buy_signals = 0,
      webhook_sell_signals = 0,
      manual_buy_signals = 0,
      manual_sell_signals = 0,
    } = counts;

    if (!instanceId) return;
    const incWebhookBuy = Number(webhook_buy_signals) || 0;
    const incWebhookSell = Number(webhook_sell_signals) || 0;
    const incManualBuy = Number(manual_buy_signals) || 0;
    const incManualSell = Number(manual_sell_signals) || 0;

    if (incWebhookBuy === 0 && incWebhookSell === 0 && incManualBuy === 0 && incManualSell === 0) {
      return;
    }

    const dateKey = snapshotDate || this._formatDateKey(toISTDate());

    const existing = await db.get(
      `SELECT id
       FROM daily_instance_pnl_snapshots
       WHERE instance_id = ? AND snapshot_date = ?`,
      [instanceId, dateKey]
    );

    if (existing) {
      await db.run(
        `UPDATE daily_instance_pnl_snapshots
         SET webhook_buy_signals = webhook_buy_signals + ?,
             webhook_sell_signals = webhook_sell_signals + ?,
             manual_buy_signals = manual_buy_signals + ?,
             manual_sell_signals = manual_sell_signals + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [incWebhookBuy, incWebhookSell, incManualBuy, incManualSell, existing.id]
      );
      return;
    }

    await db.run(
      `INSERT INTO daily_instance_pnl_snapshots
        (instance_id, snapshot_date, webhook_buy_signals, webhook_sell_signals, manual_buy_signals, manual_sell_signals)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [instanceId, dateKey, incWebhookBuy, incWebhookSell, incManualBuy, incManualSell]
    );
  }

  async listSnapshots(startDate, endDate) {
    try {
      return await db.all(
        `
          SELECT
            s.snapshot_date,
            s.total_pnl,
            s.buy_trades,
            s.sell_trades,
            s.buy_value,
            s.sell_value,
            s.webhook_buy_signals,
            s.webhook_sell_signals,
            s.manual_buy_signals,
            s.manual_sell_signals,
            s.created_at,
            s.updated_at,
            i.id AS instance_id,
            i.name AS instance_name,
            i.broker AS broker
          FROM daily_instance_pnl_snapshots s
          JOIN instances i ON i.id = s.instance_id
          WHERE s.snapshot_date BETWEEN ? AND ?
          ORDER BY s.snapshot_date DESC, i.name ASC
        `,
        [startDate, endDate]
      );
    } catch (error) {
      log.error('Failed to list daily P&L snapshots', error, { startDate, endDate });
      throw error;
    }
  }
}

export default new PnlSnapshotService();
