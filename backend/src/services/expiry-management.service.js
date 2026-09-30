/**
 * Expiry Management Service
 * Manages option expiry dates with auto-refresh logic
 * Refreshes every Wednesday and Friday at 8:00 AM IST
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import openalgoClient from '../integrations/openalgo/client.js';
import instrumentsService from './instruments.service.js';
import { NotFoundError } from '../core/errors.js';
import { toISTDate } from '../utils/time.js';
import { parseExpiry, tradableExpiries } from '../utils/underlying.util.js';
import { isCryptoExchange } from '../utils/broker-type.util.js';
import derivativeResolutionService from './derivative-resolution.service.js';

class ExpiryManagementService {
  /**
   * The nearest live expiry of an underlying's OPTIONS (default) or FUTURES.
   *
   * Read from the instruments cache, which is refreshed daily and purged of expired contracts. It
   * used to come from `expiry_calendar`, which was filled once and never refreshed: after its last
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

  /**
   * Fetch expiry dates from OpenAlgo
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {Object} instance - OpenAlgo instance
   * @returns {Promise<Array<Object>>} Array of expiry objects
   */
  async fetchExpiries(underlying, exchange, instance) {
    log.debug('Fetching expiries from OpenAlgo', { underlying, exchange });

    try {
      const cachedExpiries = await instrumentsService.getExpiries(underlying, exchange);
      if (cachedExpiries.length > 0) {
        const processedFromDb = this._processExpiries(cachedExpiries, underlying, exchange);
        await this._cacheExpiries(underlying, exchange, processedFromDb);
        log.info('Fetched expiries from instruments cache', {
          underlying,
          count: processedFromDb.length,
        });
        return processedFromDb;
      }

      const expiries = await openalgoClient.getExpiry(instance, underlying, exchange);

      // Process and classify expiries
      const processedExpiries = this._processExpiries(expiries, underlying, exchange);

      // Cache the expiries
      await this._cacheExpiries(underlying, exchange, processedExpiries);

      log.info('Fetched and cached expiries', {
        underlying,
        count: processedExpiries.length,
      });

      return processedExpiries;
    } catch (error) {
      log.error('Failed to fetch expiries from OpenAlgo', error, {
        underlying,
        exchange,
      });
      throw error;
    }
  }

  /**
   * Process and classify expiry dates
   * @private
   */
  _processExpiries(expiries, underlying, exchange) {
    const now = new Date();
    const processed = [];

    for (const expiry of expiries) {
      const expiryDate = new Date(expiry);

      // Skip past expiries
      if (expiryDate < now) {
        continue;
      }

      const dayOfWeek = expiryDate.toLocaleDateString('en-US', { weekday: 'long' });

      // Determine if weekly, monthly, or quarterly
      const isWeekly = this._isWeeklyExpiry(expiryDate);
      const isMonthly = this._isMonthlyExpiry(expiryDate);
      const isQuarterly = this._isQuarterlyExpiry(expiryDate);

      processed.push({
        underlying,
        exchange,
        expiry_date: this._formatDate(expiryDate),
        is_weekly: isWeekly,
        is_monthly: isMonthly,
        is_quarterly: isQuarterly,
        day_of_week: dayOfWeek,
        is_active: true,
      });
    }

    // Sort by date
    processed.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));

    return processed;
  }

  /**
   * Check if expiry is a weekly expiry
   * @private
   */
  _isWeeklyExpiry(date) {
    // Weekly expiries are typically on Thursdays for indices
    return date.getDay() === 4; // Thursday
  }

  /**
   * Check if expiry is a monthly expiry
   * @private
   */
  _isMonthlyExpiry(date) {
    // Monthly expiries are typically the last Thursday of the month
    const day = date.getDay();
    if (day !== 4) return false; // Not Thursday

    // Check if this is the last Thursday
    const nextWeek = new Date(date);
    nextWeek.setDate(date.getDate() + 7);

    return nextWeek.getMonth() !== date.getMonth();
  }

  /**
   * Check if expiry is a quarterly expiry
   * @private
   */
  _isQuarterlyExpiry(date) {
    // Quarterly expiries are in March, June, September, December
    const month = date.getMonth();
    const quarterMonths = [2, 5, 8, 11]; // 0-indexed: Mar, Jun, Sep, Dec

    return quarterMonths.includes(month) && this._isMonthlyExpiry(date);
  }

  /**
   * Cache expiry dates
   * @private
   */
  async _cacheExpiries(underlying, exchange, expiries) {
    try {
      for (const expiry of expiries) {
        await db.run(
          `INSERT OR REPLACE INTO expiry_calendar (
            underlying, exchange, expiry_date,
            is_weekly, is_monthly, is_quarterly, day_of_week,
            is_active, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            expiry.underlying,
            expiry.exchange,
            expiry.expiry_date,
            expiry.is_weekly ? 1 : 0,
            expiry.is_monthly ? 1 : 0,
            expiry.is_quarterly ? 1 : 0,
            expiry.day_of_week,
            expiry.is_active ? 1 : 0,
          ]
        );
      }

      log.debug('Cached expiries', { underlying, count: expiries.length });
    } catch (error) {
      log.error('Failed to cache expiries', error);
    }
  }

  /**
   * Format date to YYYY-MM-DD
   * @private
   */
  _formatDate(date) {
    // toISOString() always renders in UTC - for a midnight-IST timestamp (00:00 IST =
    // 18:30 UTC the previous day) that truncates to the wrong, earlier calendar date.
    // Build the date string from the IST-local components instead.
    const d = toISTDate(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * Get all expiries for an underlying
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {Object} options - Filter options
   * @returns {Promise<Array<Object>>} Array of expiries
   */
  async getExpiries(underlying, exchange, options = {}) {
    const { weekly, monthly, quarterly, futureOnly = true } = options;

    let query = `
      SELECT * FROM expiry_calendar
      WHERE underlying = ? AND exchange = ? AND is_active = 1
    `;
    const params = [underlying, exchange];

    if (futureOnly) {
      const todayStr = (() => {
        const d = toISTDate();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      })();
      query += ' AND expiry_date >= ?';
      params.push(todayStr);
    }

    if (weekly !== undefined) {
      query += ' AND is_weekly = ?';
      params.push(weekly ? 1 : 0);
    }

    if (monthly !== undefined) {
      query += ' AND is_monthly = ?';
      params.push(monthly ? 1 : 0);
    }

    if (quarterly !== undefined) {
      query += ' AND is_quarterly = ?';
      params.push(quarterly ? 1 : 0);
    }

    query += ' ORDER BY expiry_date ASC';

    try {
      const results = await db.all(query, params);
      return results;
    } catch (error) {
      log.error('Failed to get expiries', error);
      return [];
    }
  }

}

// Export singleton instance
export default new ExpiryManagementService();
