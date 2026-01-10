/**
 * Daily P&L Snapshot Service
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';

class PnlSnapshotService {
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
