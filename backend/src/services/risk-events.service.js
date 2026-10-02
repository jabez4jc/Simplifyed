/**
 * Risk Events Service
 * Append-only audit trail for risk/sizing decisions: stop ratchets, target/stop hits,
 * margin-based sizing computations, and strategy leg exits.
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';

class RiskEventsService {
  /**
   * @param {Object} params
   * @param {number} [params.instanceId]
   * @param {number} [params.watchlistId]
   * @param {number} [params.symbolId]
   * @param {string} [params.exchange]
   * @param {string} [params.symbol]
   * @param {string} params.eventType
   * @param {number} [params.previousValue]
   * @param {number} [params.newValue]
   * @param {Object} [params.metadata]
   * @returns {Promise<void>}
   */
  async record({
    instanceId = null,
    watchlistId = null,
    symbolId = null,
    exchange = null,
    symbol = null,
    eventType,
    previousValue = null,
    newValue = null,
    metadata = null,
  }) {
    if (!eventType) {
      log.warn('risk-events.record called without eventType, skipping');
      return;
    }

    try {
      await db.run(
        `
          INSERT INTO risk_events
            (instance_id, watchlist_id, symbol_id, exchange, symbol, event_type, previous_value, new_value, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          instanceId,
          watchlistId,
          symbolId,
          exchange,
          symbol,
          eventType,
          previousValue,
          newValue,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );
    } catch (err) {
      log.warn('Failed to record risk event', { eventType, symbol, error: err.message });
    }
  }
}

const riskEventsService = new RiskEventsService();
export default riskEventsService;
