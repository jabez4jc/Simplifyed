/**
 * Expiry Management Service
 * Manages option expiry dates with auto-refresh logic
 * Refreshes every Wednesday and Friday at 8:00 AM IST
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { NotFoundError } from '../core/errors.js';

class ExpiryManagementService {
  constructor() {
    this.refreshSchedule = null;
  }

  /**
   * Get nearest expiry date for an underlying
   * @param {string} underlying - Underlying symbol (e.g., NIFTY, RELIANCE)
   * @param {string} exchange - Exchange (NFO, BSE)
   * @param {Object} instance - OpenAlgo instance
   * @param {boolean} forceRefresh - Force refresh from OpenAlgo
   * @returns {Promise<string>} Expiry date (YYYY-MM-DD)
   */
  async getNearestExpiry(underlying, exchange, instance, forceRefresh = false) {
    log.debug('Getting nearest expiry', { underlying, exchange, forceRefresh });

    // Try cache first
    if (!forceRefresh) {
      const cached = await this._getNearestExpiryFromCache(underlying, exchange);
      if (cached) {
        log.debug('Using cached expiry', { underlying, expiry: cached });
        return cached;
      }
    }

    // Fetch from OpenAlgo
    const expiries = await this.fetchExpiries(underlying, exchange, instance);

    if (expiries.length === 0) {
      throw new NotFoundError(`No expiry dates found for ${underlying}`);
    }

    // Return the nearest expiry (first in the sorted list)
    return expiries[0].expiry_date;
  }

  /**
   * Get nearest expiry from cache
   * @private
   */
  async _getNearestExpiryFromCache(underlying, exchange) {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      const result = await db.get(
        `SELECT expiry_date FROM expiry_calendar
         WHERE underlying = ? AND exchange = ? AND is_active = 1
         AND expiry_date >= ?
         ORDER BY expiry_date ASC
         LIMIT 1`,
        [underlying, exchange, todayStr]
      );

      return result?.expiry_date || null;
    } catch (error) {
      log.error('Failed to get expiry from cache', error);
      return null;
    }
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
    return date.toISOString().split('T')[0];
  }

  /**
   * Check if expiry refresh is needed
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {Date} lastRefreshDate - Last refresh date
   * @returns {boolean} True if refresh is needed
   */
  shouldRefreshExpiry(underlying, exchange, lastRefreshDate) {
    if (!lastRefreshDate) {
      return true; // Never refreshed
    }

    const now = new Date();
    const lastRefresh = new Date(lastRefreshDate);

    // Check if today is Wednesday or Friday
    const dayOfWeek = now.getDay();
    const isWednesday = dayOfWeek === 3;
    const isFriday = dayOfWeek === 5;

    if (!isWednesday && !isFriday) {
      return false; // Not a refresh day
    }

    // Check if already refreshed today after 8 AM
    const todayRefreshTime = new Date(now);
    todayRefreshTime.setHours(8, 0, 0, 0);

    if (lastRefresh >= todayRefreshTime) {
      return false; // Already refreshed today
    }

    // Check if current time is past 8 AM
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const refreshTime = 8 * 60; // 8:00 AM in minutes

    return currentTime >= refreshTime;
  }

  /**
   * Auto-refresh expiries for all active symbols
   * Called by scheduler on Wednesday and Friday at 8:00 AM
   */
  async autoRefreshExpiries() {
    log.info('Starting auto-refresh of expiries');

    try {
      // Get all unique underlying symbols from watchlist
      const symbols = await db.all(
        `SELECT DISTINCT underlying_symbol as underlying, exchange
         FROM watchlist_symbols
         WHERE underlying_symbol IS NOT NULL AND tradable_options = 1`
      );

      if (symbols.length === 0) {
        log.debug('No symbols to refresh expiries for');
        return;
      }

      // Get a market data instance for fetching
      const instances = await db.all(
        `SELECT * FROM instances
         WHERE is_active = 1 AND (market_data_role = 'primary' OR market_data_role = 'secondary')
         ORDER BY market_data_role ASC
         LIMIT 1`
      );

      if (instances.length === 0) {
        log.warn('No active market data instance available for expiry refresh');
        return;
      }

      const instance = instances[0];

      // Refresh expiries for each symbol
      const results = await Promise.allSettled(
        symbols.map(sym =>
          this.fetchExpiries(sym.underlying, sym.exchange, instance)
        )
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      log.info('Auto-refresh of expiries completed', {
        total: symbols.length,
        successful,
        failed,
      });
    } catch (error) {
      log.error('Failed to auto-refresh expiries', error);
    }
  }

  /**
   * Start auto-refresh scheduler
   * Runs at 8:00 AM on Wednesday and Friday
   */
  startAutoRefreshScheduler() {
    if (this.refreshSchedule) {
      log.warn('Auto-refresh scheduler already running');
      return;
    }

    // Check every 5 minutes if we need to refresh
    this.refreshSchedule = setInterval(() => {
      this._checkAndRefresh();
    }, 5 * 60 * 1000); // 5 minutes

    log.info('Auto-refresh scheduler started');
  }

  /**
   * Stop auto-refresh scheduler
   */
  stopAutoRefreshScheduler() {
    if (this.refreshSchedule) {
      clearInterval(this.refreshSchedule);
      this.refreshSchedule = null;
      log.info('Auto-refresh scheduler stopped');
    }
  }

  /**
   * Check if refresh is needed and execute
   * @private
   */
  async _checkAndRefresh() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const refreshTime = 8 * 60; // 8:00 AM

    // Only on Wednesday (3) or Friday (5)
    const isRefreshDay = dayOfWeek === 3 || dayOfWeek === 5;

    // Only after 8:00 AM
    const isAfterRefreshTime = currentTime >= refreshTime;

    // Only before 8:10 AM (10-minute window)
    const isBeforeWindow = currentTime < refreshTime + 10;

    if (isRefreshDay && isAfterRefreshTime && isBeforeWindow) {
      // Check if already refreshed today
      const lastRefresh = await this._getLastGlobalRefresh();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      if (!lastRefresh || lastRefresh < todayStart) {
        log.info('Triggering auto-refresh (scheduled)');
        await this.autoRefreshExpiries();
        await this._setLastGlobalRefresh();
      }
    }
  }

  /**
   * Get last global refresh timestamp
   * @private
   */
  async _getLastGlobalRefresh() {
    try {
      const result = await db.get(
        'SELECT MAX(fetched_at) as last_refresh FROM expiry_calendar'
      );
      return result?.last_refresh ? new Date(result.last_refresh) : null;
    } catch (error) {
      log.error('Failed to get last global refresh', error);
      return null;
    }
  }

  /**
   * Set last global refresh (marker)
   * @private
   */
  async _setLastGlobalRefresh() {
    // We can use the fetched_at timestamps in expiry_calendar as the marker
    // No additional action needed since fetchExpiries updates timestamps
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
      const todayStr = new Date().toISOString().split('T')[0];
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

  /**
   * Clear expiry cache for specific underlying
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   */
  async clearCache(underlying, exchange) {
    try {
      await db.run(
        'DELETE FROM expiry_calendar WHERE underlying = ? AND exchange = ?',
        [underlying, exchange]
      );

      log.info('Cleared expiry cache', { underlying, exchange });
    } catch (error) {
      log.error('Failed to clear expiry cache', error);
    }
  }
}

// Export singleton instance
export default new ExpiryManagementService();
export { ExpiryManagementService };
