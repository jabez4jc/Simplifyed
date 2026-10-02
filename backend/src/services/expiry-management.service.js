/**
 * Expiry Management Service
 * Resolves the nearest live expiry of an underlying from the instruments table.
 */

import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import instrumentsService from './instruments.service.js';
import { NotFoundError } from '../core/errors.js';
import { parseExpiry, tradableExpiries } from '../utils/underlying.util.js';
import { isCryptoExchange } from '../utils/broker-type.util.js';
import derivativeResolutionService from './derivative-resolution.service.js';

class ExpiryManagementService {
  /**
   * The nearest live expiry of an underlying's OPTIONS (default) or FUTURES.
   *
   * Read from the instruments cache, which is refreshed daily and purged of expired contracts. It
   * used to come from a calendar table that was filled once and never refreshed: after its last
   * weekly (Aug) had passed, "nearest" NIFTY became 29-DEC, and chart orders sent with "Nearest"
   * traded December instead of the weekly the chart showed.
   *
   * Options and futures are asked for separately because their expiries differ - NIFTY options are
   * weekly while its futures are monthly, and MCX options expire days before their futures.
   *
   * @param {string} underlying - e.g. NIFTY, CRUDEOIL
   * @param {string} exchange - the underlying's or the derivative's (NSE_INDEX and NFO both work)
   * @param {Object} instance - asked only when the cache has nothing; must trade this segment
   * @param {Object} [opts]
   * @param {'OPTIONS'|'FUTURES'} [opts.kind='OPTIONS']
   * @returns {Promise<string>} Expiry date (YYYY-MM-DD)
   */
  async getNearestExpiry(underlying, exchange, instance, { kind = 'OPTIONS' } = {}) {
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(exchange);
    const crypto = isCryptoExchange(derivativeExchange);
    const instrumentTypes = kind === 'FUTURES' ? ['FUT'] : ['CE', 'PE'];

    const cached = await instrumentsService.getExpiries(underlying, derivativeExchange, { instrumentTypes });
    let nearest = tradableExpiries(cached, new Date(), { crypto })[0];

    if (!nearest && instance) {
      const fromBroker = await openalgoClient.getExpiry(
        instance, underlying, derivativeExchange, kind === 'FUTURES' ? 'futures' : 'options'
      );
      nearest = tradableExpiries(fromBroker, new Date(), { crypto })[0];
    }

    const date = parseExpiry(nearest);
    if (!date) {
      throw new NotFoundError(`No live ${kind.toLowerCase()} expiry found for ${underlying} on ${derivativeExchange}`);
    }
    log.debug('Nearest expiry', { symbol: underlying, exchange: derivativeExchange, reason: `${kind} ${nearest}` });
    return date.toISOString().slice(0, 10);
  }
}

// Export singleton instance
export default new ExpiryManagementService();
