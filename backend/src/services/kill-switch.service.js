/**
 * Global kill switch: stop all trading in one action.
 *
 * For every active instance, live and analyzer alike, in parallel:
 *   1. cancel every pending order, so nothing fills after the book is flattened;
 *   2. close every open position with quickOrderService.closeAllPositions - LIMIT orders on
 *      Indian exchanges, chased until filled - and read the book back;
 *   3. switch the instance to analyzer mode.
 *
 * A live instance whose positions are still open after step 2 is NOT switched: in analyzer mode
 * the app would stop seeing those live positions and nothing would manage them. It is reported
 * instead, so the operator can close them at the broker.
 *
 * session_cutoff_reason = 'KILL_SWITCH' keeps the new-session auto-revert (which only undoes a
 * SESSION_MAX_LOSS cutoff) from putting the instance back into live mode.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import quickOrderService from './quick-order.service.js';

class KillSwitchService {
  async run() {
    const rows = await db.all('SELECT id FROM instances WHERE is_active = 1 ORDER BY id');
    const results = await Promise.all(rows.map(({ id }) => this._stopInstance(id)));
    log.warn('Kill switch executed', {
      instances: results.length,
      failed: results.filter((r) => !r.success).map((r) => r.name),
    });
    return {
      success: results.every((r) => r.success),
      instances: results,
    };
  }

  async _stopInstance(id) {
    const result = { id, name: null, wasLive: false, closed: 0, stillOpen: [], switched: false, errors: [] };
    try {
      const instance = await instanceService.getInstanceById(id);
      result.name = instance.name;
      result.wasLive = !instance.is_analyzer_mode;

      try {
        await openalgoClient.cancelAllOrders(instance, instance.strategy_tag || 'default');
      } catch (error) {
        result.errors.push(`Cancel orders: ${error.message}`);
      }

      const closed = await quickOrderService.closeAllPositions(instance, { strategy: 'KILL_SWITCH' });
      result.closed = closed.closed;
      result.errors.push(...closed.errors);
      result.stillOpen = closed.stillOpen;

      if (result.wasLive && result.stillOpen.length) {
        result.errors.push('Left in LIVE mode: live positions are still open - close them at the broker');
      } else {
        if (result.wasLive) await openalgoClient.toggleAnalyzer(instance, true);
        await db.run(
          `UPDATE instances SET is_analyzer_mode = 1, session_cutoff_reason = 'KILL_SWITCH',
             session_cutoff_at = CURRENT_TIMESTAMP, last_analyzer_check_at = CURRENT_TIMESTAMP,
             last_updated = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [id]
        );
        result.switched = true;
      }
    } catch (error) {
      result.errors.push(error.message);
    }
    result.success = result.switched && result.stillOpen.length === 0;
    return result;
  }
}

const killSwitchService = new KillSwitchService();
export default killSwitchService;
