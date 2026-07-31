/**
 * Instruments Service
 * Manages broker instrument cache with daily refresh
 * Provides fast symbol search using SQLite FTS5 (no external search engines)
 */

import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import { config } from '../core/config.js';
import { toISTDate } from '../utils/time.js';
import { isTestMode } from '../core/config.js';
import { toISTISOString } from '../utils/time.js';
import cron from 'node-cron';
import { isCryptoBroker } from '../utils/broker-type.util.js';

const MONTH_ABBR_TO_NUMBER = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04',
  MAY: '05', JUN: '06', JUL: '07', AUG: '08',
  SEP: '09', OCT: '10', NOV: '11', DEC: '12'
};

const MONTH_NUMBER_TO_ABBR = Object.fromEntries(
  Object.entries(MONTH_ABBR_TO_NUMBER).map(([abbr, num]) => [num, abbr])
);

const EXPIRY_PATTERN = /(\d{2})([A-Z]{3})(\d{2})(?=(?:\d+(?:\.\d+)?(?:CE|PE))|FUT)/;

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

const CRYPTO_EXCHANGES = ['CRYPTO'];

/**
 * Resolve which exchange segments to query for a given instance, based on its broker.
 * @param {Object} instance - Instance row (needs .broker)
 * @returns {string[]}
 */
function getExchangesForInstance(instance) {
  return isCryptoBroker(instance?.broker) ? CRYPTO_EXCHANGES : SUPPORTED_EXCHANGES;
}

class InstrumentsService {
  constructor() {
    this.cryptoRefreshCron = null;
  }

  /**
   * Schedule a daily refresh of crypto instrument symbols at 17:31 IST. Delta Exchange rolls
   * new daily/weekly options and expiries around this time - without a refresh, newly-listed
   * contracts (e.g. a new day's options) are simply missing from the cache until someone
   * manually re-syncs. Indian exchanges already get a daily refresh via the first-login
   * middleware; crypto trades 24/7 on its own listing schedule so it needs its own trigger.
   */
  startCryptoDailyRefresh() {
    if (this.cryptoRefreshCron) return;
    this.cryptoRefreshCron = cron.schedule('31 17 * * *', () => this._refreshCryptoInstruments(), {
      timezone: 'Asia/Kolkata',
    });
    log.info('Crypto instruments daily refresh cron scheduled (17:31 IST)');
  }

  async _refreshCryptoInstruments() {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      const cryptoInstances = instances.filter((inst) => isCryptoBroker(inst.broker));
      for (const inst of cryptoInstances) {
        try {
          const result = await this.fetchFromInstance(inst.id);
          log.info('Daily crypto instruments refresh completed', {
            instance_id: inst.id,
            count: result.finalCount,
          });
        } catch (error) {
          log.error('Daily crypto instruments refresh failed', error, { instance_id: inst.id });
        }
      }
    } catch (error) {
      log.error('Daily crypto instruments refresh: failed to list instances', error);
    }
  }

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
         ${exchange ? 'AND (exchange = ? OR exchange IS NULL)' : ''}
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

  async _queryExpiriesByUnderlyingKey(underlyingKey, exchange, instrumentTypes = []) {
    if (!underlyingKey) {
      return [];
    }

    let query = `
      SELECT DISTINCT expiry
      FROM instruments
      WHERE underlying_key = ? AND exchange = ? AND expiry IS NOT NULL
    `;
    const params = [underlyingKey, exchange];

    if (instrumentTypes.length > 0) {
      const clauses = instrumentTypes.map(() => 'UPPER(instrumenttype) LIKE ?').join(' OR ');
      query += ` AND (${clauses})`;
      instrumentTypes.forEach(type => {
        const normalized = type.toUpperCase();
        const isExact = normalized === 'CE' || normalized === 'PE';
        params.push(isExact ? normalized : `${normalized}%`);
      });
    }

    return db.all(query, params);
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

    // Skip refresh in test mode (test instances don't have valid instruments).
    // Same isTestMode() as the auth middleware - config.testMode was a second, independent
    // switch fed by a different env var, and has been removed.
    if (isTestMode()) {
      log.info('Test mode: Skipping instruments refresh', {
        exchange: exchange || 'ALL'
      });
      return {
        success: true,
        count: 0,
        duration_ms: 0,
        skipped: true,
        reason: 'TEST_MODE'
      };
    }

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
        ) VALUES (?, 'in_progress', ?)`,
        [exchange || null, toISTISOString()]
      );

      refreshLogId = logResult.lastID;

      // Fetch instruments from OpenAlgo
      // If no exchange specified, fetch from all supported exchanges
      let instruments = [];

      if (exchange) {
        // Single exchange
        instruments = await openalgoClient.getInstruments(instance, exchange);
      } else {
        // All exchanges for this instance's broker - fetch from each and combine
        const exchanges = getExchangesForInstance(instance);
        log.info('Fetching instruments from all exchanges', {
          exchanges
        });

        for (const ex of exchanges) {
          try {
            const exInstruments = await openalgoClient.getInstruments(instance, ex);
            if (exInstruments && exInstruments.length > 0) {
              instruments.push(...exInstruments);
              log.info(`Fetched instruments from ${ex}`, { count: exInstruments.length });
            }
          } catch (error) {
            // Log error but continue with other exchanges
            log.warn(`Failed to fetch instruments from ${ex}`, {
              error: error.message
            });
          }
        }
      }

      if (!instruments || instruments.length === 0) {
        throw new Error('No instruments returned from broker');
      }

      log.info('Fetched instruments from broker', {
        count: instruments.length,
        exchange: exchange || 'ALL'
      });

      // Store instruments in database (in transaction for atomicity)
      await db.transaction(async () => {
        // Delete existing instruments for the exchange(s) being refreshed only -
        // never wipe exchanges outside this instance's broker (e.g. a crypto instance
        // refresh must not delete cached Indian broker instruments, and vice versa)
        if (exchange) {
          await db.run('DELETE FROM instruments WHERE exchange = ?', [exchange]);
          log.debug('Cleared existing instruments for exchange', { exchange });
        } else {
          const exchanges = getExchangesForInstance(instance);
          const placeholders = exchanges.map(() => '?').join(', ');
          await db.run(`DELETE FROM instruments WHERE exchange IN (${placeholders})`, exchanges);
          log.debug('Cleared existing instruments for exchanges', { exchanges });
        }

        // Batch insert instruments (SQLite max 999 parameters, each instrument has 12 fields)
        const batchSize = 75; // 75 * 13 < 999 (including timestamps)
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

          // Build VALUES clause with placeholders (11 fields + 2 timestamps)
          const placeholders = batch
            .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
            .join(', ');

          // Flatten values for all instruments in batch
          const values = batch.flatMap(inst => {
            const normalizedInstrument = {
              symbol: inst.symbol ? inst.symbol.toUpperCase() : null,
              instrumenttype: inst.instrumenttype ? inst.instrumenttype.toUpperCase() : null,
              name: inst.name ? inst.name.toUpperCase() : null,
            };
            const underlyingKey = this._deriveUnderlyingKey(normalizedInstrument);
            return [
              normalizedInstrument.symbol,
              inst.brsymbol || null,
              inst.name || null,
              inst.exchange ? inst.exchange.toUpperCase() : null,
              inst.brexchange || null,
              inst.token || null,
              inst.expiry || null,
              inst.strike || null,
              inst.lotsize || 1,
              normalizedInstrument.instrumenttype,
              underlyingKey,
              inst.tick_size || null
            ];
          });

          await db.run(
            `INSERT OR REPLACE INTO instruments (
              symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
              lotsize, instrumenttype, underlying_key, tick_size, created_at, updated_at
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
             refresh_completed_at = ?
         WHERE id = ?`,
        [instruments.length, toISTISOString(), refreshLogId]
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

      // Validate and clamp limit
      let validatedLimit = parseInt(limit, 10);
      if (isNaN(validatedLimit) || validatedLimit < 1) {
        validatedLimit = 50;
      }
      validatedLimit = Math.min(Math.max(validatedLimit, 1), 500); // Clamp between 1 and 500

      // Sanitize query for FTS5 to prevent operator injection
      // Escape double-quotes by doubling them (FTS5 standard)
      let sanitizedQuery = query
        .replace(/"/g, '""') // Escape double-quotes
        .trim();

      // Check if query is empty after sanitization
      if (sanitizedQuery.length === 0) {
        throw new ValidationError('Search query must contain valid characters');
      }

      // Wrap as phrase prefix to prevent FTS5 operators (AND/OR/NOT) from being parsed
      // The "*" inside quotes tells FTS5 to do phrase prefix matching
      const ftsQuery = `"${sanitizedQuery}*"`;

      log.debug('Searching instruments', {
        query: sanitizedQuery,
        exchange,
        instrumenttype,
        limit: validatedLimit
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
      params.push(validatedLimit);

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
      const normalizedSymbol = String(symbol || '').toUpperCase();

      // Try multiple expiry formats since DB might store different formats
      const expiryFormats = this._getExpiryFormats(expiry);

      let options = [];
      for (const expiryFormat of expiryFormats) {
        options = await db.all(
          `SELECT * FROM instruments
           WHERE underlying_key = ? AND expiry = ? AND exchange = ? AND strike IS NOT NULL
           ORDER BY strike ASC`,
          [normalizedSymbol, expiryFormat, exchange]
        );

        if (options && options.length > 0) {
          log.debug('Found options with expiry format', {
            symbol: normalizedSymbol,
            expiryFormat,
            count: options.length
          });
          break;
        }
      }

      // Fallback: try symbol LIKE match with multiple expiry formats
      if (!options || options.length === 0) {
        for (const expiryFormat of expiryFormats) {
          options = await db.all(
            `SELECT * FROM instruments
             WHERE symbol LIKE ? AND expiry = ? AND exchange = ? AND strike IS NOT NULL
             ORDER BY strike ASC`,
            [`${normalizedSymbol}%`, expiryFormat, exchange]
          );

          if (options && options.length > 0) {
            log.debug('Found options via symbol LIKE with expiry format', {
              symbol: normalizedSymbol,
              expiryFormat,
              count: options.length
            });
            break;
          }
        }
      }

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
  async getExpiries(symbol, exchange = 'NFO', options = {}) {
    const instrumentTypes = Array.isArray(options.instrumentTypes)
      ? options.instrumentTypes.filter(Boolean)
      : (typeof options.instrumentTypes === 'string' && options.instrumentTypes.length > 0
          ? options.instrumentTypes.split(',').map(type => type.trim()).filter(Boolean)
          : []);
    const matchField = options.matchField === 'name' ? 'name' : 'symbol';
    const useName = matchField === 'name';
    try {
      const normalizedSymbol = String(symbol || '').toUpperCase();
      const buildQuery = (field) => {
        const searchValue = `${normalizedSymbol}%`;
        let q = `
          SELECT DISTINCT expiry
          FROM instruments
          WHERE UPPER(${field}) LIKE ? AND exchange = ?
        `;
        const params = [
          searchValue,
          exchange,
        ];

        if (instrumentTypes.length > 0) {
          const clauses = instrumentTypes.map(() => 'UPPER(instrumenttype) LIKE ?').join(' OR ');
          q += ` AND (${clauses})`;
          instrumentTypes.forEach(type => {
            const normalized = type.toUpperCase();
            const isExact = normalized === 'CE' || normalized === 'PE';
            params.push(isExact ? normalized : `${normalized}%`);
          });
        }

        return { query: q, params };
      };

      let rows = await this._queryExpiriesByUnderlyingKey(
        normalizedSymbol,
        exchange,
        instrumentTypes
      );
      let expiries = this._buildExpiryDisplayList(rows);

      if (!expiries || expiries.length === 0) {
        let { query, params } = buildQuery(matchField);
        let fallbackRows = await db.all(query, params);
        expiries = this._buildExpiryDisplayList(fallbackRows);

        if ((!expiries || expiries.length === 0) && useName) {
          ({ query, params } = buildQuery('symbol'));
          fallbackRows = await db.all(query, params);
          expiries = this._buildExpiryDisplayList(fallbackRows);
        }
      }

      return expiries || [];
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
          completed_at: toISTISOString(lastRefresh.refresh_completed_at),
          count: lastRefresh.instrument_count,
          exchange: lastRefresh.exchange || 'ALL'
        } : null
      };
    } catch (error) {
      log.error('Failed to get statistics', error);
      throw error;
    }
  }

  _normalizeExpiryDate(expiry) {
    if (!expiry) return null;
    const trimmed = String(expiry).trim().toUpperCase();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    const match = trimmed.match(/^(\d{2})-([A-Z]{3})-(\d{2})$/);
    if (match) {
      const [, day, monthStr, year] = match;
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const monthIndex = months.indexOf(monthStr);
      if (monthIndex === -1) {
        return null;
      }
      const isoMonth = String(monthIndex + 1).padStart(2, '0');
      return `20${year}-${isoMonth}-${day}`;
    }

    return null;
  }

  _buildExpiryDisplayList(rows = []) {
    const map = new Map();
    const todayIso = (() => {
      const d = toISTDate();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    for (const row of rows) {
      if (!row || !row.expiry) continue;
      const normalized = this._normalizeExpiryDate(row.expiry);
      if (!normalized) continue;
      // Skip past expiries to avoid showing or using stale contracts
      if (normalized < todayIso) continue;
      if (!map.has(normalized)) {
        const display = this._formatExpiryForDisplay(normalized) || row.expiry;
        map.set(normalized, display);
      }
    }

    return Array.from(map.entries())
      .map(([normalized, display]) => ({
        normalized,
        display,
        timestamp: normalized ? Date.parse(normalized) : null
      }))
      .sort((a, b) => {
        if (a.timestamp && b.timestamp) {
          return a.timestamp - b.timestamp;
        }
        if (a.timestamp) return -1;
        if (b.timestamp) return 1;
        return (a.display || '').localeCompare(b.display || '');
      })
      .map(entry => entry.display);
  }

  _formatExpiryForDisplay(normalizedExpiry) {
    if (!normalizedExpiry) return null;
    const match = normalizedExpiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return normalizedExpiry;
    }

    const [, year, month, day] = match;
    const monthName = MONTH_NUMBER_TO_ABBR[month] || month;
    return `${day}-${monthName}-${year.slice(-2)}`;
  }

  /**
   * Generate multiple expiry format variants to try when querying
   * Different brokers store expiry in different formats
   * @param {string} expiry - Input expiry date
   * @returns {Array<string>} - Array of expiry formats to try
   * @private
   */
  _getExpiryFormats(expiry) {
    if (!expiry) return [];

    const formats = new Set();
    const trimmed = String(expiry).trim().toUpperCase();
    formats.add(trimmed);

    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    // Try to parse ISO format (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [year, month, day] = trimmed.split('-');
      const monthName = months[parseInt(month, 10) - 1];
      const shortYear = year.slice(-2);

      // Add variants: DD-MMM-YY, DDMMMYY
      formats.add(`${day}-${monthName}-${shortYear}`);
      formats.add(`${day}${monthName}${shortYear}`);
      formats.add(`${day}-${monthName}-${year}`);
    }

    // Try to parse DD-MMM-YY format
    const ddMmmYyMatch = trimmed.match(/^(\d{2})-([A-Z]{3})-(\d{2})$/);
    if (ddMmmYyMatch) {
      const [, day, monthStr, shortYear] = ddMmmYyMatch;
      const monthIndex = months.indexOf(monthStr);
      if (monthIndex !== -1) {
        const isoMonth = String(monthIndex + 1).padStart(2, '0');
        const fullYear = `20${shortYear}`;

        // Add variants: YYYY-MM-DD, DDMMMYY, DD-MMM-YYYY
        formats.add(`${fullYear}-${isoMonth}-${day}`);
        formats.add(`${day}${monthStr}${shortYear}`);
        formats.add(`${day}-${monthStr}-${fullYear}`);
      }
    }

    // Try to parse DDMMMYY format (no dashes)
    const ddMmmYyNoDash = trimmed.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
    if (ddMmmYyNoDash) {
      const [, day, monthStr, shortYear] = ddMmmYyNoDash;
      const monthIndex = months.indexOf(monthStr);
      if (monthIndex !== -1) {
        const isoMonth = String(monthIndex + 1).padStart(2, '0');
        const fullYear = `20${shortYear}`;

        // Add variants: YYYY-MM-DD, DD-MMM-YY
        formats.add(`${fullYear}-${isoMonth}-${day}`);
        formats.add(`${day}-${monthStr}-${shortYear}`);
      }
    }

    return Array.from(formats);
  }

  /**
   * Get market data instance (primary admin > secondary admin ONLY)
   * @private
   */
  async _getMarketDataInstance(instanceId) {
    if (instanceId) {
      const instance = await instanceService.getInstanceById(instanceId);
      if (!instance) {
        throw new ValidationError(`Instance with ID ${instanceId} not found`);
      }
      return instance;
    }

    // Prefer configured market data instance pool (supports multiquotes)
    try {
      const mdInstance = await marketDataInstanceService.getMarketDataInstance();
      if (mdInstance) {
        return mdInstance;
      }
    } catch (err) {
      log.warn('Failed to get market data instance for instruments refresh, falling back', { error: err.message });
    }

    // Fallback: any healthy active instance
    const instances = await instanceService.getAllInstances({ is_active: true });
    const healthy = instances.filter(inst => inst.health_status === 'healthy');
    if (healthy.length === 0) {
      throw new ValidationError('No healthy instances available for instruments refresh');
    }
    return healthy[0];
  }

  /**
   * Import instruments from CSV file
   *
   * @param {string} csvContent - CSV file content as string
   * @returns {Promise<Object>} - Import result with counts and stats
   */
  async importFromCSV(csvContent) {
    const startTime = Date.now();

    try {
      log.info('Starting CSV import');

      // Parse CSV content
      const lines = csvContent.trim().split('\n');

      if (lines.length < 2) {
        throw new ValidationError('CSV file is empty or invalid');
      }

      // Skip header
      const header = lines.shift();
      log.info('CSV header', { header });

      const totalRecords = lines.length;
      let inserted = 0;
      let skipped = 0;
      const BATCH_SIZE = 1000;

      // Clear existing instruments
      log.info('Clearing existing instruments');
      await db.run('DELETE FROM instruments');

      // Process in batches
      for (let i = 0; i < lines.length; i += BATCH_SIZE) {
        const batch = lines.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];

        for (const line of batch) {
          if (!line.trim()) {
            skipped++;
            continue;
          }

          // Parse CSV line (handle quoted fields)
          const fields = this._parseCsvLine(line);

          if (fields.length < 12) {
            log.warn('Skipping invalid CSV line', { line: line.substring(0, 50) });
            skipped++;
            continue;
          }

          const [
            id, symbol, brsymbol, name, exchange, brexchange,
            token, expiry, strike, lotsize, instrumenttype, tick_size
          ] = fields;

          // Prepare values (convert empty strings to null)
          const normalizedInstrument = {
            symbol: symbol ? symbol.toUpperCase() : null,
            instrumenttype: instrumenttype ? instrumenttype.toUpperCase() : null,
            name: name ? name.toUpperCase() : null,
          };
          const underlyingKey = this._deriveUnderlyingKey(normalizedInstrument);

          const shouldDeriveExpiry = underlyingKey &&
            this._isDerivativeInstrumentType(normalizedInstrument.instrumenttype);
          const derivedExpiry = shouldDeriveExpiry
            ? this._deriveExpiryFromSymbol(
                normalizedInstrument.symbol,
                normalizedInstrument.instrumenttype
              )
            : null;
          const rawExpiry = expiry ? expiry.trim() : '';
          const normalizedInputExpiry = rawExpiry && rawExpiry !== '-1'
            ? this._normalizeExpiryDate(rawExpiry)
            : null;
          const expiryValue = derivedExpiry || normalizedInputExpiry;

          const value = [
            normalizedInstrument.symbol,
            brsymbol || null,
            name || null,
            exchange ? exchange.toUpperCase() : null,
            brexchange || null,
            token || null,
            expiryValue,
            strike === '-1' || strike === '' ? null : strike,
            lotsize === '-1' || lotsize === '' ? 1 : parseInt(lotsize, 10),
            normalizedInstrument.instrumenttype,
            underlyingKey,
            tick_size === '-1' || tick_size === '' ? null : tick_size
          ];

          values.push(...value);
          placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))');
        }

        if (placeholders.length > 0) {
          // Insert batch
          const sql = `
            INSERT INTO instruments (
              symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
              lotsize, instrumenttype, underlying_key, tick_size, created_at, updated_at
            ) VALUES ${placeholders.join(', ')}
          `;

          await db.run(sql, values);
          inserted += placeholders.length;

          log.info('CSV import batch processed', {
            batch: Math.floor(i / BATCH_SIZE) + 1,
            inserted,
            progress: `${((i + batch.length) / lines.length * 100).toFixed(1)}%`
          });
        }
      }

      // Rebuild FTS table
      log.info('Rebuilding FTS table');
      await db.run('DELETE FROM instruments_fts');
      await db.run(`
        INSERT INTO instruments_fts(rowid, symbol, name)
        SELECT id, symbol, name FROM instruments
      `);

      const duration = Date.now() - startTime;

      // Get final count
      const countResult = await db.get('SELECT COUNT(*) as count FROM instruments');
      const finalCount = countResult.count;

      // Update refresh log
      await db.run(`
        INSERT INTO instruments_refresh_log (
          exchange, status, instrument_count, refresh_started_at, refresh_completed_at
        ) VALUES ('CSV_UPLOAD', 'completed', ?, ?, ?)
      `, [finalCount, toISTISOString(), toISTISOString()]);

      const result = {
        total: totalRecords,
        inserted,
        skipped,
        finalCount,
        duration: `${(duration / 1000).toFixed(2)}s`,
        rate: `${(finalCount / (duration / 1000)).toFixed(0)} records/sec`
      };

      log.info('CSV import completed', result);

      return result;
    } catch (error) {
      log.error('CSV import failed', error);
      throw error;
    }
  }

  _deriveUnderlyingKey(instrument) {
    if (!instrument) return null;
    const symbol = (instrument.symbol || '').toUpperCase().replace(/\s+/g, '');
    const instrumentType = (instrument.instrumenttype || '').toUpperCase();

    if (!symbol) {
      return null;
    }

    // For non-derivatives (EQ, INDEX), use the symbol directly
    const isDerivative = instrumentType.startsWith('FUT') || instrumentType.startsWith('OPT') ||
                         instrumentType === 'CE' || instrumentType === 'PE';
    if (!isDerivative) {
      return symbol;
    }

    // For derivatives, extract the alphabetic prefix from symbol
    const cleaned = symbol.replace(/[^A-Z0-9]/g, '');
    const prefixMatch = cleaned.match(/^([A-Z]+)/);
    if (prefixMatch && prefixMatch[1]) {
      return prefixMatch[1];
    }

    // If no alphabetic prefix found, return the cleaned symbol
    return cleaned || null;
  }

  _isDerivativeInstrumentType(instrumentType) {
    if (!instrumentType) return false;
    const normalized = instrumentType.toUpperCase();
    return normalized.startsWith('FUT') ||
           normalized.startsWith('OPT') ||
           normalized === 'CE' ||
           normalized === 'PE';
  }

  /**
   * Derive expiry date (ISO YYYY-MM-DD) from futures/options symbol
   * Returns null for non-derivatives or symbols without an expiry fragment.
   * @private
   */
  _deriveExpiryFromSymbol(symbol, instrumentType) {
    if (!symbol || !this._isDerivativeInstrumentType(instrumentType)) return null;
    const upperSymbol = symbol.toUpperCase();
    const match = upperSymbol.match(EXPIRY_PATTERN);
    if (!match || match.length < 4) {
      return null;
    }

    const [, dayFragment, monthFragment, yearFragment] = match;
    const day = String(dayFragment).padStart(2, '0');
    const monthAbbr = monthFragment;
    let year = yearFragment;

    const monthNumber = MONTH_ABBR_TO_NUMBER[monthAbbr];
    if (!monthNumber) {
      return null;
    }

    if (year.length === 2) {
      year = `20${year}`;
    }
    if (year.length !== 4 || Number.isNaN(Number(year))) {
      return null;
    }

    const dayNumber = Number(day);
    if (Number.isNaN(dayNumber) || dayNumber < 1 || dayNumber > 31) {
      return null;
    }

    return `${year}-${monthNumber}-${day}`;
  }

  /**
   * Parse CSV line handling quoted fields
   * @private
   */
  _parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote mode
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Field separator
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    // Add last field
    fields.push(current.trim());

    return fields;
  }

  /**
   * Fetch instruments from an OpenAlgo instance for all exchanges
   *
   * @param {number} instanceId - Instance ID to fetch from
   * @returns {Promise<Object>} - Fetch result with counts and stats
   */
  async fetchFromInstance(instanceId, onProgress = null) {
    const startTime = Date.now();

    try {
      // Get instance details
      const instance = await instanceService.getInstanceById(instanceId);
      if (!instance) {
        throw new ValidationError(`Instance ${instanceId} not found`);
      }

      log.info('Starting instruments fetch from instance', {
        instanceId,
        instance_name: instance.name
      });

      let totalInstruments = 0;
      const exchangeStats = {};

      // Resolve which exchange segments belong to this instance's broker (Indian vs crypto)
      // and only clear those - a crypto instance sync must not wipe cached Indian broker
      // instruments (and an Indian broker sync must not wipe cached crypto instruments)
      const exchanges = getExchangesForInstance(instance);

      log.info('Clearing existing instruments for exchanges', { exchanges });
      const clearPlaceholders = exchanges.map(() => '?').join(', ');
      await db.run(`DELETE FROM instruments WHERE exchange IN (${clearPlaceholders})`, exchanges);

      // Notify progress callback
      if (onProgress) {
        onProgress({
          status: 'clearing',
          message: 'Clearing existing instruments...',
          currentExchange: null,
          completedExchanges: [],
          totalInstruments: 0
        });
      }

      // Fetch from each exchange
      for (const exchange of exchanges) {
        try {
          log.info(`Fetching instruments for exchange: ${exchange}`);

          // Notify progress callback - starting exchange
          if (onProgress) {
            const completedExchanges = Object.keys(exchangeStats);
            onProgress({
              status: 'fetching',
              message: `Fetching ${exchange}...`,
              currentExchange: exchange,
              completedExchanges,
              totalInstruments
            });
          }

          // Call OpenAlgo API
          const response = await openalgoClient.getInstruments(
            instance,
            exchange
          );

          if (!response || !Array.isArray(response)) {
            log.warn(`No instruments returned for ${exchange}`);
            exchangeStats[exchange] = { count: 0, status: 'empty' };
            continue;
          }

          // Insert instruments in batches
          const BATCH_SIZE = 70;
          let inserted = 0;

          for (let i = 0; i < response.length; i += BATCH_SIZE) {
            const batch = response.slice(i, i + BATCH_SIZE);
            const values = [];
            const placeholders = [];

            for (const instrument of batch) {
              const normalizedInstrument = {
                symbol: instrument.symbol ? instrument.symbol.toUpperCase() : null,
                instrumenttype: instrument.instrumenttype ? instrument.instrumenttype.toUpperCase() : null,
                name: instrument.name ? instrument.name.toUpperCase() : null,
              };
              const underlyingKey = this._deriveUnderlyingKey(normalizedInstrument);
              const shouldDeriveExpiry = underlyingKey &&
                this._isDerivativeInstrumentType(normalizedInstrument.instrumenttype);
              const derivedExpiry = shouldDeriveExpiry
                ? this._deriveExpiryFromSymbol(
                    normalizedInstrument.symbol,
                    normalizedInstrument.instrumenttype
                  )
                : null;
              const expiryInput = instrument.expiry ? String(instrument.expiry).trim() : '';
              const normalizedInputExpiry = expiryInput && expiryInput !== '-1'
                ? this._normalizeExpiryDate(expiryInput)
                : null;
              const expiryValue = derivedExpiry || normalizedInputExpiry;

              const value = [
                normalizedInstrument.symbol,
                instrument.brsymbol || null,
                instrument.name || null,
                (instrument.exchange || exchange || '').toUpperCase(),
                instrument.brexchange || null,
                instrument.token || null,
                expiryValue,
                instrument.strike === '-1' || !instrument.strike ? null : instrument.strike,
                instrument.lotsize === '-1' || !instrument.lotsize ? 1 : parseInt(instrument.lotsize, 10),
                normalizedInstrument.instrumenttype,
                underlyingKey,
                instrument.tick_size === '-1' || !instrument.tick_size ? null : instrument.tick_size
              ];

              values.push(...value);
              placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))');
            }

            if (placeholders.length > 0) {
              const sql = `
                INSERT INTO instruments (
                  symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
                  lotsize, instrumenttype, underlying_key, tick_size, created_at, updated_at
                ) VALUES ${placeholders.join(', ')}
              `;

              await db.run(sql, values);
              inserted += placeholders.length;
            }
          }

          exchangeStats[exchange] = { count: inserted, status: 'success' };
          totalInstruments += inserted;

          // Notify progress callback - exchange completed
          if (onProgress) {
            const completedExchanges = Object.keys(exchangeStats);
            onProgress({
              status: 'completed',
              message: `Completed ${exchange} (${inserted.toLocaleString()} instruments)`,
              currentExchange: exchange,
              completedExchanges,
              totalInstruments
            });
          }

          log.info(`Fetched ${inserted} instruments from ${exchange}`);
        } catch (error) {
          log.error(`Failed to fetch instruments from ${exchange}`, error);
          exchangeStats[exchange] = { count: 0, status: 'error', error: error.message };

          // Notify progress callback - exchange failed
          if (onProgress) {
            const completedExchanges = Object.keys(exchangeStats);
            onProgress({
              status: 'error',
              message: `Failed ${exchange}: ${error.message}`,
              currentExchange: exchange,
              completedExchanges,
              totalInstruments
            });
          }
        }
      }

      // Rebuild FTS table
      log.info('Rebuilding FTS table');

      // Notify progress callback - rebuilding FTS
      if (onProgress) {
        onProgress({
          status: 'rebuilding',
          message: 'Rebuilding search index...',
          currentExchange: null,
          completedExchanges: exchanges,
          totalInstruments
        });
      }

      await db.run('DELETE FROM instruments_fts');
      await db.run(`
        INSERT INTO instruments_fts(rowid, symbol, name)
        SELECT id, symbol, name FROM instruments
      `);

      // Notify progress callback - completed
      if (onProgress) {
        onProgress({
          status: 'completed',
          message: 'All instruments fetched successfully!',
          currentExchange: null,
          completedExchanges: exchanges,
          totalInstruments
        });
      }

      const duration = Date.now() - startTime;

      // Get final count
      const countResult = await db.get('SELECT COUNT(*) as count FROM instruments');
      const finalCount = countResult.count;

      // Update refresh log
      await db.run(`
        INSERT INTO instruments_refresh_log (
          exchange, status, instrument_count, refresh_started_at, refresh_completed_at
        ) VALUES ('INSTANCE_FETCH', 'completed', ?, ?, ?)
      `, [finalCount, toISTISOString(), toISTISOString()]);

      const result = {
        totalInstruments,
        finalCount,
        exchangeStats,
        duration: `${(duration / 1000).toFixed(2)}s`,
        rate: `${(finalCount / (duration / 1000)).toFixed(0)} records/sec`
      };

      log.info('Instruments fetch from instance completed', result);

      return result;
    } catch (error) {
      log.error('Instruments fetch from instance failed', error);
      throw error;
    }
  }
}

export default new InstrumentsService();
export { InstrumentsService, SUPPORTED_EXCHANGES, CRYPTO_EXCHANGES };
export const ALL_EXCHANGES = [...SUPPORTED_EXCHANGES, ...CRYPTO_EXCHANGES];
