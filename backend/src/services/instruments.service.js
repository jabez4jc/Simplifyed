/**
 * Instruments Service
 * Manages broker instrument cache with daily refresh
 * Provides fast symbol search using SQLite FTS5 (no external search engines)
 */

import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import { toISTDate } from '../utils/time.js';
import { isTestMode } from '../core/config.js';
import { toISTISOString } from '../utils/time.js';
import cron from 'node-cron';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';
import { parseExpiry, upcomingExpiries, isContractExpired } from '../utils/underlying.util.js';
import futuresRollService from './futures-roll.service.js';

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

// A refresh is per segment: an Indian broker serves the Indian exchanges and a crypto broker
// serves CRYPTO, so each segment is fetched from an instance that actually serves it. The segment
// name is also what instruments_refresh_log.exchange holds for a completed refresh.
const SEGMENTS = { INDIAN: SUPPORTED_EXCHANGES, CRYPTO: CRYPTO_EXCHANGES };
const STALE_AFTER_HOURS = 24;
const INSERT_BATCH = 75; // 75 rows * 12 bound values stays far under SQLite's variable limit
const ROW_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)';

/** -1, '', null and 0 all mean "no value" in the broker feeds. */
const orNull = (value) => (!value || Number(value) === -1 ? null : value);

function segmentForInstance(instance) {
  return isCryptoBroker(instance?.broker) ? 'CRYPTO' : 'INDIAN';
}

class InstrumentsService {
  constructor() {
    this.crons = [];
    this.refreshing = new Map(); // segment -> in-flight refresh
  }

  /**
   * Schedule the daily refreshes and the expiry purge, and refresh at boot if a segment is stale.
   * Indian master contracts are republished before the open; crypto lists new dailies/weeklies
   * around 17:30 IST. Nothing refreshes inside an HTTP request.
   */
  startScheduledRefresh() {
    if (this.crons.length) return;
    const at = (when, fn) => cron.schedule(when, fn, { timezone: 'Asia/Kolkata' });
    const refresh = (segment) => () => this.refreshSegment(segment)
      .catch((error) => log.error(`Daily ${segment} instruments refresh failed`, error));
    const purge = () => this.purgeExpired().catch((error) => log.error('Expired instruments purge failed', error));
    // Expired contracts cease to exist: purge after crypto's 17:30 lapse (plus the sync buffer in
    // underlying.util.js) and just after midnight for Indian segments, which settle end of day.
    this.crons = [
      at('30 8 * * *', refresh('INDIAN')),
      at('31 17 * * *', refresh('CRYPTO')),
      at('50 17 * * *', purge),
      at('5 0 * * *', purge),
    ];
    log.info('Instruments refresh crons scheduled (Indian 08:30 IST, crypto 17:31 IST)');
    purge();
    this.refreshIfStale().catch((error) => log.error('Boot instruments refresh failed', error));
  }

  stopScheduledRefresh() {
    this.crons.forEach((job) => job.stop());
    this.crons = [];
  }

  /**
   * Expired contracts cease to exist, so they must not stay in the cache - an order, a lot or
   * tick lookup, or a position check must never resolve against one. Indian segments settle at
   * end of day; crypto lapses at 5:30 PM IST (upcomingExpiries holds the rule). Rows with no
   * expiry (cash, indices, perpetuals) and unparseable expiries are left alone.
   * @returns {Promise<number>} rows removed
   */
  async purgeExpired(now = new Date()) {
    const rows = await db.all(
      "SELECT exchange, expiry, COUNT(*) AS n FROM instruments WHERE expiry IS NOT NULL AND expiry != '' GROUP BY exchange, expiry"
    );
    let removed = 0;
    for (const row of rows) {
      if (!parseExpiry(row.expiry)) continue;
      const alive = upcomingExpiries([row.expiry], now, { crypto: isCryptoExchange(row.exchange) }).length > 0;
      if (alive) continue;
      await db.run('DELETE FROM instruments WHERE exchange = ? AND expiry = ?', [row.exchange, row.expiry]);
      removed += row.n;
    }
    if (removed > 0) {
      await this._rebuildFts();
      log.info('Purged expired contracts from the instruments cache', { count: removed });
    }
    // Auto-roll rows move to their next contract first; only what could not roll is disabled.
    await futuresRollService.rollAll(now);
    await this.disableExpiredWatchlistSymbols(now);
    return removed;
  }

  /**
   * Watchlist rows for expired contracts are switched off (is_enabled = 0) so nothing - polling,
   * WS subscriptions, quick orders, auto-exit - treats them as live. The rows stay, flagged
   * is_expired, so the operator sees what expired and can remove it or add the new contract.
   */
  async disableExpiredWatchlistSymbols(now = new Date()) {
    const rows = await db.all('SELECT id, exchange, symbol, trading_symbol, expiry FROM watchlist_symbols WHERE is_enabled = 1')
      .catch(() => []);
    const expired = rows.filter((row) => isContractExpired(row, now));
    for (const row of expired) {
      await db.run('UPDATE watchlist_symbols SET is_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    }
    if (expired.length > 0) {
      log.info('Disabled expired watchlist symbols', { count: expired.length, reason: expired.map((r) => r.symbol).join(', ') });
    }
    return expired.length;
  }

  /**
   * Whether a segment's cache must be refreshed: empty, never completed a refresh, or older than
   * 24 hours. With no segment, any segment that an active instance serves counts (a crypto
   * segment nobody trades is never "stale").
   *
   * @param {'INDIAN'|'CRYPTO'} [segment]
   * @returns {Promise<boolean>}
   */
  async needsRefresh(segment = null) {
    try {
      const segments = segment ? [segment] : await this._segmentsInUse();
      for (const seg of segments) {
        if (await this._segmentStale(seg)) return true;
      }
      return false;
    } catch (error) {
      log.error('Failed to check refresh status', error, { segment });
      return true; // Err on the side of refreshing
    }
  }

  async _segmentStale(segment) {
    const exchanges = SEGMENTS[segment];
    if (!exchanges) throw new ValidationError(`Unknown instruments segment: ${segment}`);

    const { count } = await db.get(
      `SELECT COUNT(*) AS count FROM instruments WHERE exchange IN (${exchanges.map(() => '?').join(', ')})`,
      exchanges
    );
    if (count === 0) {
      log.info('No instruments cached for segment, refresh needed', { segment });
      return true;
    }

    const last = await db.get(
      `SELECT refresh_completed_at FROM instruments_refresh_log
       WHERE status = 'completed' AND exchange = ?
       ORDER BY refresh_completed_at DESC LIMIT 1`,
      [segment]
    );
    if (!last) {
      log.info('No successful refresh found for segment, refresh needed', { segment });
      return true;
    }

    const hours = (Date.now() - new Date(last.refresh_completed_at).getTime()) / (1000 * 60 * 60);
    return hours > STALE_AFTER_HOURS;
  }

  async _segmentsInUse() {
    const instances = await instanceService.getAllInstances({ is_active: true });
    return Object.keys(SEGMENTS).filter((seg) => instances.some((inst) => segmentForInstance(inst) === seg));
  }

  isRefreshing() {
    return this.refreshing.size > 0;
  }

  /** Boot-time catch-up: refresh each segment in use whose cache is stale. */
  async refreshIfStale() {
    for (const segment of await this._segmentsInUse()) {
      if (!(await this._segmentStale(segment))) continue;
      await this.refreshSegment(segment).catch((error) => log.error('Instruments refresh failed', error, { segment }));
    }
  }

  /**
   * Refresh one segment from an instance that serves it (healthy ones first, falling through to
   * the next if a fetch fails outright). Concurrent calls share one run.
   */
  async refreshSegment(segment) {
    if (!SEGMENTS[segment]) throw new ValidationError(`Unknown instruments segment: ${segment}`);
    if (!this.refreshing.has(segment)) {
      const run = this._refreshSegment(segment).finally(() => this.refreshing.delete(segment));
      this.refreshing.set(segment, run);
    }
    return this.refreshing.get(segment);
  }

  async _refreshSegment(segment) {
    // Test instances have no real instruments. Same isTestMode() as the auth middleware.
    if (isTestMode()) {
      log.info('Test mode: skipping instruments refresh', { segment });
      return { success: true, skipped: true, reason: 'TEST_MODE' };
    }

    const instances = (await instanceService.getAllInstances({ is_active: true }))
      .filter((inst) => segmentForInstance(inst) === segment)
      .sort((a, b) => Number(b.health_status === 'healthy') - Number(a.health_status === 'healthy'));
    if (instances.length === 0) {
      log.debug('No active instance serves this instruments segment', { segment });
      return { success: true, skipped: true, reason: 'NO_INSTANCE' };
    }

    let lastError;
    for (const inst of instances) {
      try {
        return await this.fetchFromInstance(inst.id);
      } catch (error) {
        lastError = error;
        log.warn('Instruments refresh failed on instance, trying the next', { segment, instance_id: inst.id, error: error.message });
      }
    }
    throw lastError;
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
      const clauses = instrumentTypes.map(() => 'instrumenttype LIKE ?').join(' OR ');
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

      // Quoted so FTS5 operators (AND/OR/NOT) are taken literally; the prefix star goes OUTSIDE
      // the quotes. Inside them it was tokenized away, so "BTCUSD*" only ever matched the exact
      // token BTCUSD and never found BTCUSDFUT.
      const ftsQuery = `"${sanitizedQuery}" *`;

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

      // FTS rank alone put SBIN's future above SBIN itself. Over-fetch, drop anything expired,
      // then rank: exact symbol, same underlying, then cash/index, futures, options - nearest
      // expiry first.
      const upper = sanitizedQuery.toUpperCase();
      sql += ' ORDER BY (i.symbol = ?) DESC, (i.instrumenttype IN (\'CE\', \'PE\')) ASC, fts.rank LIMIT ?';
      params.push(upper, validatedLimit * 4);

      const typeRank = (r) => {
        const t = String(r.instrumenttype || '').toUpperCase();
        if (t === 'CE' || t === 'PE') return 3;
        if (t.includes('FUT')) return 2;
        return 1;
      };
      const expiryTime = (r) => parseExpiry(r.expiry)?.getTime() ?? 0;
      const now = new Date();
      const results = (await db.all(sql, params))
        .filter((r) => !isContractExpired(r, now))
        .sort((a, b) => (
          (a.symbol === upper ? 0 : 1) - (b.symbol === upper ? 0 : 1)
          // NIFTY's own futures before the fifty other indices whose names start with NIFTY.
          || (String(a.name).toUpperCase() === upper ? 0 : 1) - (String(b.name).toUpperCase() === upper ? 0 : 1)
          || typeRank(a) - typeRank(b)
          || expiryTime(a) - expiryTime(b)
          || (a.rank ?? 0) - (b.rank ?? 0)
        ))
        .slice(0, validatedLimit);

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

      // Stored as ISO (YYYY-MM-DD); callers may hand over DD-MMM-YY or DDMMMYY.
      const expiryKey = this._normalizeExpiryDate(expiry) || String(expiry || '').trim().toUpperCase();

      let options = await db.all(
        `SELECT * FROM instruments
         WHERE underlying_key = ? AND expiry = ? AND exchange = ? AND strike IS NOT NULL
         ORDER BY strike ASC`,
        [normalizedSymbol, expiryKey, exchange]
      );

      // Fallback: symbol prefix match
      if (!options || options.length === 0) {
        options = await db.all(
          `SELECT * FROM instruments
           WHERE symbol LIKE ? AND expiry = ? AND exchange = ? AND strike IS NOT NULL
           ORDER BY strike ASC`,
          [`${normalizedSymbol}%`, expiryKey, exchange]
        );
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
          WHERE ${field} LIKE ? AND exchange = ?
        `;
        const params = [
          searchValue,
          exchange,
        ];

        if (instrumentTypes.length > 0) {
          const clauses = instrumentTypes.map(() => 'instrumenttype LIKE ?').join(' OR ');
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

    const match = trimmed.match(/^(\d{2})-?([A-Z]{3})-?(\d{2})$/);
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
   * Replace one exchange's instruments: delete its rows and bulk-insert the new ones in a single
   * transaction, with expiry normalised to ISO (YYYY-MM-DD). The caller rebuilds the FTS index once
   * after however many exchanges it loads (_rebuildFts) - the table is external-content, so it is
   * never edited row by row.
   *
   * @param {string} exchange
   * @param {Object[]} instruments - OpenAlgo-shaped rows (symbol, brsymbol, name, token, expiry, ...)
   * @returns {Promise<number>} rows written
   */
  async replaceExchange(exchange, instruments) {
    const ex = String(exchange || '').toUpperCase();
    if (!ex) throw new ValidationError('exchange is required');
    const rows = instruments.map((inst) => this._toRow(inst, ex)).filter(Boolean);

    await db.transaction(async () => {
      await db.run('DELETE FROM instruments WHERE exchange = ?', [ex]);
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH);
        await db.run(
          `INSERT OR REPLACE INTO instruments (
            symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
            lotsize, instrumenttype, underlying_key, tick_size, created_at, updated_at
          ) VALUES ${batch.map(() => ROW_PLACEHOLDERS).join(', ')}`,
          batch.flat()
        );
      }
    });
    return rows.length;
  }

  /** One normalised instruments row (column order of replaceExchange's INSERT), or null without a symbol. */
  _toRow(inst, exchange) {
    const symbol = inst.symbol ? String(inst.symbol).toUpperCase() : null;
    if (!symbol) return null;
    const instrumenttype = inst.instrumenttype ? String(inst.instrumenttype).toUpperCase() : null;
    const underlyingKey = this._deriveUnderlyingKey({ symbol, instrumenttype });
    const expiry = this._deriveExpiryFromSymbol(symbol, instrumenttype) || this._normalizeExpiryDate(inst.expiry);
    const lotsize = parseInt(orNull(inst.lotsize), 10);

    return [
      symbol,
      inst.brsymbol || null,
      inst.name || null,
      exchange,
      inst.brexchange || null,
      inst.token || null,
      expiry,
      orNull(inst.strike),
      Number.isFinite(lotsize) ? lotsize : 1,
      instrumenttype,
      underlyingKey,
      orNull(inst.tick_size),
    ];
  }

  /** Re-index the external-content FTS table from `instruments`; run after a bulk load or purge. */
  async _rebuildFts() {
    await db.run("INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')");
  }

  /**
   * Import instruments from CSV file. Replaces only the exchanges present in the file.
   *
   * @param {string} csvContent - CSV file content as string
   * @returns {Promise<Object>} - Import result with counts and stats
   */
  async importFromCSV(csvContent) {
    const startTime = Date.now();

    try {
      log.info('Starting CSV import');

      const lines = csvContent.trim().split('\n');
      if (lines.length < 2) {
        throw new ValidationError('CSV file is empty or invalid');
      }
      lines.shift(); // header

      const totalRecords = lines.length;
      let skipped = 0;
      const byExchange = new Map();

      for (const line of lines) {
        const fields = line.trim() ? this._parseCsvLine(line) : [];
        if (fields.length < 12) {
          skipped++;
          continue;
        }
        const [, symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size] = fields;
        const ex = (exchange || '').toUpperCase();
        if (!ex) {
          skipped++;
          continue;
        }
        if (!byExchange.has(ex)) byExchange.set(ex, []);
        byExchange.get(ex).push({ symbol, brsymbol, name, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size });
      }

      let inserted = 0;
      for (const [ex, rows] of byExchange) {
        inserted += await this.replaceExchange(ex, rows);
        log.info('CSV import exchange replaced', { exchange: ex, rows: rows.length });
      }
      await this._rebuildFts();

      await this.purgeExpired();
      const duration = Date.now() - startTime;

      const { count: finalCount } = await db.get('SELECT COUNT(*) as count FROM instruments');
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
   * Fetch instruments from an OpenAlgo instance for its broker's segment (Indian or crypto).
   * Only that segment's exchanges are replaced, and an exchange only once its new list has
   * arrived: a failed or empty download leaves the previous cache in place.
   *
   * @param {number} instanceId - Instance ID to fetch from
   * @returns {Promise<Object>} - Fetch result with counts and stats
   */
  async fetchFromInstance(instanceId, onProgress = null) {
    const startTime = Date.now();
    let refreshLogId = null;

    try {
      const instance = await instanceService.getInstanceById(instanceId);
      if (!instance) {
        throw new ValidationError(`Instance ${instanceId} not found`);
      }

      const segment = segmentForInstance(instance);
      const exchanges = SEGMENTS[segment];
      log.info('Starting instruments fetch from instance', { instanceId, instance_name: instance.name, segment });

      const logResult = await db.run(
        `INSERT INTO instruments_refresh_log (exchange, status, refresh_started_at) VALUES (?, 'in_progress', ?)`,
        [segment, toISTISOString()]
      );
      refreshLogId = logResult.lastID;

      let totalInstruments = 0;
      const exchangeStats = {};
      const progress = (status, message, currentExchange = null) => onProgress?.({
        status,
        message,
        currentExchange,
        completedExchanges: Object.keys(exchangeStats),
        totalInstruments,
      });

      for (const exchange of exchanges) {
        try {
          progress('fetching', `Fetching ${exchange}...`, exchange);
          const response = await openalgoClient.getInstruments(instance, exchange);

          if (!Array.isArray(response) || response.length === 0) {
            log.warn(`No instruments returned for ${exchange}`);
            exchangeStats[exchange] = { count: 0, status: 'empty' };
            continue;
          }

          const inserted = await this.replaceExchange(exchange, response);
          exchangeStats[exchange] = { count: inserted, status: 'success' };
          totalInstruments += inserted;
          progress('completed', `Completed ${exchange} (${inserted.toLocaleString()} instruments)`, exchange);
          log.info(`Fetched ${inserted} instruments from ${exchange}`);
        } catch (error) {
          log.error(`Failed to fetch instruments from ${exchange}`, error);
          exchangeStats[exchange] = { count: 0, status: 'error', error: error.message };
          progress('error', `Failed ${exchange}: ${error.message}`, exchange);
        }
      }

      if (totalInstruments === 0) {
        throw new Error('No instruments returned from broker');
      }

      progress('rebuilding', 'Rebuilding search index...');
      await this._rebuildFts();
      await this.purgeExpired();

      const failed = Object.entries(exchangeStats).filter(([, st]) => st.status === 'error');
      const { count: finalCount } = await db.get(
        `SELECT COUNT(*) AS count FROM instruments WHERE exchange IN (${exchanges.map(() => '?').join(', ')})`,
        exchanges
      );
      // Only a clean run counts as the segment's refresh; a partial one is retried at the next trigger.
      await db.run(
        `UPDATE instruments_refresh_log
         SET status = ?, instrument_count = ?, refresh_completed_at = ?, error_message = ?
         WHERE id = ?`,
        [failed.length ? 'failed' : 'completed', finalCount, toISTISOString(),
          failed.length ? failed.map(([ex, st]) => `${ex}: ${st.error}`).join('; ') : null, refreshLogId]
      );
      progress('completed', 'All instruments fetched successfully!');

      const duration = Date.now() - startTime;
      const result = {
        totalInstruments,
        finalCount,
        exchangeStats,
        duration: `${(duration / 1000).toFixed(2)}s`,
        rate: `${(totalInstruments / (duration / 1000)).toFixed(0)} records/sec`
      };

      log.info('Instruments fetch from instance completed', result);

      return result;
    } catch (error) {
      if (refreshLogId) {
        await db.run(
          `UPDATE instruments_refresh_log SET status = 'failed', error_message = ? WHERE id = ?`,
          [error.message, refreshLogId]
        ).catch((err) => log.warn('Failed to update refresh log', err));
      }
      log.error('Instruments fetch from instance failed', error);
      throw error;
    }
  }
}

export default new InstrumentsService();
export { SUPPORTED_EXCHANGES };
