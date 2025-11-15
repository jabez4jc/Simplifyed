/**
 * Instruments Service
 * Manages broker instrument cache with daily refresh
 * Provides fast symbol search using SQLite FTS5 and optional Elasticsearch
 */

import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

/**
 * Exchanges supported by OpenAlgo
 */
const SUPPORTED_EXCHANGES = [
  'NSE',
  'BSE',
  'NFO',
  'BFO',
  'BCD',
  'CDS',
  'MCX',
  'NSE_INDEX',
  'BSE_INDEX'
];

class InstrumentsService {
  /**
   * Check if instruments need to be refreshed
   * Refresh is needed if:
   * 1. No instruments exist in database
   * 2. Last refresh was more than 24 hours ago
   * 3. Last refresh failed
   *
   * @param {string} [exchange] - Optional exchange to check
   * @returns {Promise<boolean>} - true if refresh is needed
   */
  async needsRefresh(exchange = null) {
    try {
      // Check if we have any instruments at all
      const countResult = await db.get(
        'SELECT COUNT(*) as count FROM instruments' +
        (exchange ? ' WHERE exchange = ?' : ''),
        exchange ? [exchange] : []
      );

      if (countResult.count === 0) {
        log.info('No instruments found in cache, refresh needed', { exchange });
        return true;
      }

      // Check last refresh log
      const lastRefresh = await db.get(
        `SELECT * FROM instruments_refresh_log
         WHERE status = 'completed'
         ${exchange ? 'AND exchange = ?' : ''}
         ORDER BY refresh_completed_at DESC
         LIMIT 1`,
        exchange ? [exchange] : []
      );

      if (!lastRefresh) {
        log.info('No successful refresh found, refresh needed', { exchange });
        return true;
      }

      // Check if last refresh was more than 24 hours ago
      const lastRefreshTime = new Date(lastRefresh.refresh_completed_at).getTime();
      const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60);

      if (hoursSinceRefresh > 24) {
        log.info('Last refresh was more than 24 hours ago, refresh needed', {
          exchange,
          hoursSinceRefresh: hoursSinceRefresh.toFixed(2)
        });
        return true;
      }

      log.debug('Instruments cache is fresh', {
        exchange,
        hoursSinceRefresh: hoursSinceRefresh.toFixed(2),
        instrumentCount: countResult.count
      });

      return false;
    } catch (error) {
      log.error('Failed to check refresh status', error, { exchange });
      return true; // Err on the side of refreshing
    }
  }

  /**
   * Refresh instruments from broker
   * Fetches complete instrument list and stores in database
   *
   * @param {string} [exchange] - Optional exchange to refresh (null = all exchanges)
   * @param {number} [instanceId] - Optional instance ID to use
   * @returns {Promise<Object>} - Refresh result with count and status
   */
  async refreshInstruments(exchange = null, instanceId = null) {
    const startTime = Date.now();
    let refreshLogId = null;

    try {
      // Get market data instance
      const instance = await this._getMarketDataInstance(instanceId);

      log.info('Starting instruments refresh', {
        exchange: exchange || 'ALL',
        instance_id: instance.id,
        instance_name: instance.name
      });

      // Create refresh log entry
      const logResult = await db.run(
        `INSERT INTO instruments_refresh_log (
          exchange, status, refresh_started_at
        ) VALUES (?, 'in_progress', CURRENT_TIMESTAMP)`,
        [exchange || null]
      );

      refreshLogId = logResult.lastID;

      // Fetch instruments from OpenAlgo
      const instruments = await openalgoClient.getInstruments(instance, exchange);

      if (!instruments || instruments.length === 0) {
        throw new Error('No instruments returned from broker');
      }

      log.info('Fetched instruments from broker', {
        count: instruments.length,
        exchange: exchange || 'ALL'
      });

      // Store instruments in database (in transaction for atomicity)
      await db.transaction(async () => {
        // Delete existing instruments for this exchange
        if (exchange) {
          await db.run('DELETE FROM instruments WHERE exchange = ?', [exchange]);
          log.debug('Cleared existing instruments for exchange', { exchange });
        } else {
          await db.run('DELETE FROM instruments');
          log.debug('Cleared all existing instruments');
        }

        // Batch insert instruments (SQLite max 999 parameters, each instrument has 11 fields)
        const batchSize = 90; // 90 * 11 = 990 parameters (under 999 limit)
        const batches = [];

        for (let i = 0; i < instruments.length; i += batchSize) {
          batches.push(instruments.slice(i, i + batchSize));
        }

        log.debug('Inserting instruments in batches', {
          totalInstruments: instruments.length,
          batchCount: batches.length,
          batchSize
        });

        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];

          // Build VALUES clause with placeholders
          const placeholders = batch
            .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
            .join(', ');

          // Flatten values for all instruments in batch
          const values = batch.flatMap(inst => [
            inst.symbol || null,
            inst.brsymbol || null,
            inst.name || null,
            inst.exchange || null,
            inst.token || null,
            inst.expiry || null,
            inst.strike || null,
            inst.lotsize || 1,
            inst.instrumenttype || null,
            inst.tick_size || null
          ]);

          await db.run(
            `INSERT INTO instruments (
              symbol, brsymbol, name, exchange, token, expiry, strike,
              lotsize, instrumenttype, tick_size, created_at, updated_at
            ) VALUES ${placeholders}`,
            values
          );

          // Log progress for large datasets
          if (i % 10 === 0 || i === batches.length - 1) {
            const progress = ((i + 1) / batches.length * 100).toFixed(1);
            log.debug('Batch insert progress', {
              batch: i + 1,
              total: batches.length,
              progress: `${progress}%`
            });
          }
        }
      });

      const duration = Date.now() - startTime;

      // Update refresh log with success
      await db.run(
        `UPDATE instruments_refresh_log
         SET status = 'completed',
             instrument_count = ?,
             refresh_completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [instruments.length, refreshLogId]
      );

      log.info('Instruments refresh completed successfully', {
        exchange: exchange || 'ALL',
        count: instruments.length,
        duration_ms: duration,
        duration_sec: (duration / 1000).toFixed(2)
      });

      return {
        success: true,
        count: instruments.length,
        exchange: exchange || 'ALL',
        duration_ms: duration
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Update refresh log with failure
      if (refreshLogId) {
        await db.run(
          `UPDATE instruments_refresh_log
           SET status = 'failed',
               error_message = ?
           WHERE id = ?`,
          [error.message, refreshLogId]
        ).catch(err => log.warn('Failed to update refresh log', err));
      }

      log.error('Instruments refresh failed', error, {
        exchange: exchange || 'ALL',
        duration_ms: duration
      });

      throw error;
    }
  }

  /**
   * Search instruments using SQLite FTS5 full-text search
   * Searches across symbol and name fields
   *
   * @param {string} query - Search query
   * @param {Object} filters - Optional filters
   * @param {string} [filters.exchange] - Filter by exchange
   * @param {string} [filters.instrumenttype] - Filter by instrument type
   * @param {number} [filters.limit] - Max results (default: 50)
   * @returns {Promise<Array>} - Matching instruments
   */
  async searchInstruments(query, filters = {}) {
    try {
      if (!query || query.trim().length < 2) {
        throw new ValidationError('Search query must be at least 2 characters');
      }

      const {
        exchange = null,
        instrumenttype = null,
        limit = 50
      } = filters;

      // Sanitize query for FTS5 (escape special characters)
      const sanitizedQuery = query
        .replace(/['"]/g, '') // Remove quotes
        .trim();

      // Build FTS5 query with prefix matching
      const ftsQuery = `${sanitizedQuery}*`;

      log.debug('Searching instruments', {
        query: sanitizedQuery,
        exchange,
        instrumenttype,
        limit
      });

      // Use FTS5 for fast search, then join with instruments table for full data
      let sql = `
        SELECT
          i.*,
          fts.rank
        FROM instruments_fts fts
        JOIN instruments i ON fts.rowid = i.id
        WHERE instruments_fts MATCH ?
      `;

      const params = [ftsQuery];

      // Add exchange filter
      if (exchange) {
        sql += ' AND i.exchange = ?';
        params.push(exchange);
      }

      // Add instrument type filter
      if (instrumenttype) {
        sql += ' AND i.instrumenttype = ?';
        params.push(instrumenttype);
      }

      // Order by FTS5 rank (relevance) and limit results
      sql += ' ORDER BY fts.rank LIMIT ?';
      params.push(limit);

      const results = await db.all(sql, params);

      log.info('Instrument search completed', {
        query: sanitizedQuery,
        results: results.length,
        exchange,
        instrumenttype
      });

      return results;
    } catch (error) {
      log.error('Instrument search failed', error, { query, filters });
      throw error;
    }
  }

  /**
   * Get instrument by exact symbol and exchange match
   *
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @returns {Promise<Object|null>} - Instrument or null if not found
   */
  async getInstrument(symbol, exchange) {
    try {
      const instrument = await db.get(
        `SELECT * FROM instruments
         WHERE symbol = ? AND exchange = ?
         LIMIT 1`,
        [symbol.toUpperCase(), exchange.toUpperCase()]
      );

      return instrument || null;
    } catch (error) {
      log.error('Failed to get instrument', error, { symbol, exchange });
      return null;
    }
  }

  /**
   * Build option chain for a symbol
   * Returns all available strikes for given expiry
   *
   * @param {string} symbol - Underlying symbol (e.g., NIFTY, BANKNIFTY)
   * @param {string} expiry - Expiry date
   * @param {string} [exchange] - Exchange code (default: NFO)
   * @returns {Promise<Object>} - Option chain with CE and PE arrays
   */
  async buildOptionChain(symbol, expiry, exchange = 'NFO') {
    try {
      log.debug('Building option chain', { symbol, expiry, exchange });

      // Get all options for this symbol and expiry
      const options = await db.all(
        `SELECT * FROM instruments
         WHERE symbol LIKE ? AND expiry = ? AND exchange = ? AND strike IS NOT NULL
         ORDER BY strike ASC`,
        [`${symbol}%`, expiry, exchange]
      );

      // Separate CE and PE options
      const callOptions = [];
      const putOptions = [];

      for (const option of options) {
        // Determine option type from symbol suffix or instrumenttype
        const optionSymbol = option.symbol.toUpperCase();
        const instrumentType = (option.instrumenttype || '').toUpperCase();

        if (optionSymbol.endsWith('CE') || instrumentType === 'CE') {
          callOptions.push(option);
        } else if (optionSymbol.endsWith('PE') || instrumentType === 'PE') {
          putOptions.push(option);
        }
      }

      // Group by strike price
      const strikes = {};

      for (const ce of callOptions) {
        const strike = ce.strike;
        if (!strikes[strike]) {
          strikes[strike] = { strike, ce: null, pe: null };
        }
        strikes[strike].ce = ce;
      }

      for (const pe of putOptions) {
        const strike = pe.strike;
        if (!strikes[strike]) {
          strikes[strike] = { strike, ce: null, pe: null };
        }
        strikes[strike].pe = pe;
      }

      // Convert to array and sort by strike
      const optionChain = Object.values(strikes).sort((a, b) => a.strike - b.strike);

      log.info('Option chain built successfully', {
        symbol,
        expiry,
        exchange,
        strikes: optionChain.length,
        ce_count: callOptions.length,
        pe_count: putOptions.length
      });

      return {
        symbol,
        expiry,
        exchange,
        strikes: optionChain,
        metadata: {
          total_strikes: optionChain.length,
          ce_count: callOptions.length,
          pe_count: putOptions.length
        }
      };
    } catch (error) {
      log.error('Failed to build option chain', error, { symbol, expiry, exchange });
      throw error;
    }
  }

  /**
   * Get available expiry dates for a symbol
   *
   * @param {string} symbol - Underlying symbol
   * @param {string} [exchange] - Exchange code (default: NFO)
   * @returns {Promise<Array>} - Array of expiry dates
   */
  async getExpiries(symbol, exchange = 'NFO') {
    try {
      const expiries = await db.all(
        `SELECT DISTINCT expiry
         FROM instruments
         WHERE symbol LIKE ? AND exchange = ? AND expiry IS NOT NULL
         ORDER BY expiry ASC`,
        [`${symbol}%`, exchange]
      );

      return expiries.map(row => row.expiry);
    } catch (error) {
      log.error('Failed to get expiries', error, { symbol, exchange });
      return [];
    }
  }

  /**
   * Get instruments statistics
   *
   * @returns {Promise<Object>} - Statistics by exchange and instrument type
   */
  async getStatistics() {
    try {
      // Get counts by exchange
      const byExchange = await db.all(
        `SELECT exchange, COUNT(*) as count
         FROM instruments
         GROUP BY exchange
         ORDER BY count DESC`
      );

      // Get counts by instrument type
      const byType = await db.all(
        `SELECT instrumenttype, COUNT(*) as count
         FROM instruments
         GROUP BY instrumenttype
         ORDER BY count DESC`
      );

      // Get total count
      const total = await db.get('SELECT COUNT(*) as count FROM instruments');

      // Get last refresh info
      const lastRefresh = await db.get(
        `SELECT * FROM instruments_refresh_log
         WHERE status = 'completed'
         ORDER BY refresh_completed_at DESC
         LIMIT 1`
      );

      return {
        total: total.count,
        by_exchange: byExchange,
        by_type: byType,
        last_refresh: lastRefresh ? {
          completed_at: lastRefresh.refresh_completed_at,
          count: lastRefresh.instrument_count,
          exchange: lastRefresh.exchange || 'ALL'
        } : null
      };
    } catch (error) {
      log.error('Failed to get statistics', error);
      throw error;
    }
  }

  /**
   * Get market data instance (primary > secondary > any healthy)
   * @private
   */
  async _getMarketDataInstance(instanceId) {
    if (instanceId) {
      return await instanceService.getInstanceById(instanceId);
    }

    // Prefer market data instances
    const marketDataInstances = await instanceService.getMarketDataInstances();
    if (marketDataInstances.length > 0) {
      return marketDataInstances[0];
    }

    // Fallback to any healthy active instance
    const instances = await instanceService.getAllInstances({
      is_active: true
    });

    const healthyInstances = instances.filter(
      (inst) => inst.health_status === 'healthy'
    );

    if (healthyInstances.length === 0) {
      throw new ValidationError(
        'No healthy instances available for instruments refresh'
      );
    }

    return healthyInstances[0];
  }
}

export default new InstrumentsService();
export { InstrumentsService, SUPPORTED_EXCHANGES };
