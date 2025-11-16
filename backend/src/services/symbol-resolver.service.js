/**
 * Symbol Resolver Service
 * Server-side symbol resolution and strike calculation
 *
 * Responsibilities:
 * - Classify symbols (equity, futures, options, templates)
 * - Resolve strike templates (ATM, ITM, OTM with offsets)
 * - Calculate actual strike prices from LTP
 * - Validate symbols against instruments cache
 * - Support FLOAT_OFS and DISCRETE_OFS strike policies
 *
 * Features:
 * - Template parsing (NIFTY_ATM_CE, BANKNIFTY_100ITM_PE, etc.)
 * - Strike rounding based on index tick size
 * - Instrument lookup from cache
 * - Multi-expiry support
 * - Lot size retrieval
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';

class SymbolResolverService {
  constructor() {
    // Index-specific strike intervals
    this.strikeIntervals = {
      'NIFTY': 50,
      'BANKNIFTY': 100,
      'FINNIFTY': 50,
      'MIDCPNIFTY': 25,
      'SENSEX': 100,
      'BANKEX': 100,
    };
  }

  /**
   * Resolve a symbol (may be template or actual symbol)
   * @param {Object} params - Resolution parameters
   * @param {string} params.symbol - Symbol or template (e.g., "NIFTY_ATM_CE")
   * @param {string} params.exchange - Exchange
   * @param {Object} params.instance - Instance object for LTP fetching
   * @param {string} params.expiry - Optional expiry (default: nearest)
   * @param {string} params.strikePolicy - FLOAT_OFS or DISCRETE_OFS
   * @returns {Promise<Object>} - Resolved symbol data
   */
  async resolveSymbol(params) {
    try {
      const { symbol, exchange, instance, expiry, strikePolicy = 'FLOAT_OFS' } = params;

      // Check if symbol is a template
      if (this._isTemplate(symbol)) {
        return await this._resolveTemplate({
          template: symbol,
          exchange,
          instance,
          expiry,
          strikePolicy,
        });
      }

      // Direct symbol - look up in instruments cache
      return await this._lookupSymbol(symbol, exchange);
    } catch (error) {
      log.error('Failed to resolve symbol', error, { symbol: params.symbol });
      throw error;
    }
  }

  /**
   * Classify a symbol
   * @param {string} symbol - Symbol to classify
   * @returns {Object} - Classification result
   */
  classifySymbol(symbol) {
    // Template patterns: SYMBOL_MODIFIER_TYPE
    // Examples: NIFTY_ATM_CE, BANKNIFTY_100ITM_PE, NIFTY_50OTM_CE
    const templatePattern = /^([A-Z0-9]+)_(ATM|[0-9]+ITM|[0-9]+OTM)_(CE|PE)$/;
    const templateMatch = symbol.match(templatePattern);

    if (templateMatch) {
      return {
        isTemplate: true,
        indexName: templateMatch[1],
        strikeModifier: templateMatch[2],
        optionType: templateMatch[3],
      };
    }

    // Option symbol patterns: SYMBOLDDMMMYYSTRIKEOTYPE
    // Examples: NIFTY2440024400CE, BANKNIFTY24400CE
    const optionPattern = /^([A-Z]+)(\d{5})(\d+)(CE|PE)$/;
    const optionMatch = symbol.match(optionPattern);

    if (optionMatch) {
      return {
        isTemplate: false,
        isOption: true,
        indexName: optionMatch[1],
        expiryCode: optionMatch[2],
        strike: parseInt(optionMatch[3]),
        optionType: optionMatch[4],
      };
    }

    // Futures pattern: SYMBOLDDMMMYYFUT
    const futuresPattern = /^([A-Z]+)(\d{5})FUT$/;
    const futuresMatch = symbol.match(futuresPattern);

    if (futuresMatch) {
      return {
        isTemplate: false,
        isFutures: true,
        indexName: futuresMatch[1],
        expiryCode: futuresMatch[2],
      };
    }

    // Equity or index
    return {
      isTemplate: false,
      isEquity: true,
      symbol,
    };
  }

  /**
   * Get LTP for an index or symbol
   * @param {Object} instance - Instance object
   * @param {string} symbol - Symbol
   * @param {string} exchange - Exchange
   * @returns {Promise<number>} - Last traded price
   */
  async getLTP(instance, symbol, exchange) {
    try {
      const quote = await openalgoClient.getQuote(instance, {
        exchange,
        symbol,
      });

      const ltp = parseFloat(quote.ltp || quote.last_price || 0);

      if (!ltp || ltp <= 0) {
        throw new Error(`Invalid LTP for ${symbol}: ${ltp}`);
      }

      return ltp;
    } catch (error) {
      log.error('Failed to get LTP', error, { symbol, exchange });
      throw error;
    }
  }

  /**
   * Calculate strike price from LTP and modifier
   * @param {number} ltp - Last traded price
   * @param {string} modifier - Strike modifier (ATM, 100ITM, 50OTM, etc.)
   * @param {string} optionType - CE or PE
   * @param {string} indexName - Index name for strike interval
   * @param {string} strikePolicy - FLOAT_OFS or DISCRETE_OFS
   * @returns {number} - Calculated strike price
   */
  calculateStrike(ltp, modifier, optionType, indexName, strikePolicy = 'FLOAT_OFS') {
    const strikeInterval = this.strikeIntervals[indexName] || 50;

    let baseStrike;

    // Round LTP to nearest strike interval for ATM
    if (modifier === 'ATM') {
      baseStrike = Math.round(ltp / strikeInterval) * strikeInterval;
    } else {
      // Extract offset (e.g., "100ITM" -> 100)
      const offsetMatch = modifier.match(/^(\d+)(ITM|OTM)$/);
      if (!offsetMatch) {
        throw new Error(`Invalid strike modifier: ${modifier}`);
      }

      const offset = parseInt(offsetMatch[1]);
      const direction = offsetMatch[2];

      // Calculate offset in points
      let offsetPoints;

      if (strikePolicy === 'FLOAT_OFS') {
        // Offset is in absolute points
        offsetPoints = offset;
      } else {
        // DISCRETE_OFS: offset is in multiples of strike interval
        offsetPoints = offset * strikeInterval;
      }

      // Apply offset based on option type and direction
      const atmStrike = Math.round(ltp / strikeInterval) * strikeInterval;

      if (direction === 'ITM') {
        // ITM: CE = lower strike, PE = higher strike
        if (optionType === 'CE') {
          baseStrike = atmStrike - offsetPoints;
        } else {
          baseStrike = atmStrike + offsetPoints;
        }
      } else {
        // OTM: CE = higher strike, PE = lower strike
        if (optionType === 'CE') {
          baseStrike = atmStrike + offsetPoints;
        } else {
          baseStrike = atmStrike - offsetPoints;
        }
      }

      // Round to nearest strike interval
      baseStrike = Math.round(baseStrike / strikeInterval) * strikeInterval;
    }

    return baseStrike;
  }

  /**
   * Get nearest expiry for an index
   * @param {string} indexName - Index name
   * @param {string} exchange - Exchange
   * @returns {Promise<string>} - Nearest expiry in YYMMDD format
   */
  async getNearestExpiry(indexName, exchange) {
    try {
      // Get all available expiries from instruments cache
      const expiries = await db.all(
        `SELECT DISTINCT expiry FROM instruments
         WHERE symbol LIKE ?
         AND exchange = ?
         AND expiry >= date('now')
         ORDER BY expiry ASC
         LIMIT 1`,
        [`${indexName}%`, exchange]
      );

      if (expiries.length === 0) {
        throw new Error(`No expiries found for ${indexName} on ${exchange}`);
      }

      // Convert YYYY-MM-DD to YYMMDDD format
      const expiry = expiries[0].expiry;
      const date = new Date(expiry);
      const yy = date.getFullYear().toString().slice(-2);
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');

      return `${yy}${mm}${dd}`;
    } catch (error) {
      log.error('Failed to get nearest expiry', error, { indexName, exchange });
      throw error;
    }
  }

  /**
   * Find option instrument in cache
   * @param {string} indexName - Index name
   * @param {number} strike - Strike price
   * @param {string} optionType - CE or PE
   * @param {string} expiry - Expiry in YYMMDD format
   * @param {string} exchange - Exchange
   * @returns {Promise<Object>} - Instrument record
   */
  async findOptionInstrument(indexName, strike, optionType, expiry, exchange) {
    try {
      // Build symbol: INDEXYYMMDDSTRIKEOTYPE
      const symbol = `${indexName}${expiry}${strike}${optionType}`;

      const instrument = await db.get(
        `SELECT * FROM instruments
         WHERE symbol = ?
         AND exchange = ?`,
        [symbol, exchange]
      );

      if (!instrument) {
        throw new Error(`Option not found: ${symbol} on ${exchange}`);
      }

      return instrument;
    } catch (error) {
      log.error('Failed to find option instrument', error, {
        indexName,
        strike,
        optionType,
        expiry,
        exchange,
      });
      throw error;
    }
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Check if symbol is a template
   * @private
   */
  _isTemplate(symbol) {
    return /^[A-Z0-9]+_(ATM|[0-9]+ITM|[0-9]+OTM)_(CE|PE)$/.test(symbol);
  }

  /**
   * Resolve a template symbol
   * @private
   */
  async _resolveTemplate(params) {
    const { template, exchange, instance, expiry, strikePolicy } = params;

    // Classify template
    const classification = this.classifySymbol(template);
    if (!classification.isTemplate) {
      throw new Error(`Symbol is not a template: ${template}`);
    }

    const { indexName, strikeModifier, optionType } = classification;

    // Get LTP for underlying index
    const ltp = await this.getLTP(instance, indexName, exchange);

    // Calculate strike
    const strike = this.calculateStrike(
      ltp,
      strikeModifier,
      optionType,
      indexName,
      strikePolicy
    );

    // Get expiry (use provided or nearest)
    let expiryCode;
    if (expiry) {
      // Convert YYYY-MM-DD to YYMMDD
      const date = new Date(expiry);
      const yy = date.getFullYear().toString().slice(-2);
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      expiryCode = `${yy}${mm}${dd}`;
    } else {
      expiryCode = await this.getNearestExpiry(indexName, exchange);
    }

    // Find instrument
    const instrument = await this.findOptionInstrument(
      indexName,
      strike,
      optionType,
      expiryCode,
      exchange
    );

    log.info('Template resolved', {
      template,
      ltp,
      strike,
      resolved_symbol: instrument.symbol,
    });

    return {
      original_template: template,
      resolved_symbol: instrument.symbol,
      index_name: indexName,
      index_ltp: ltp,
      strike,
      option_type: optionType,
      expiry: expiryCode,
      exchange: instrument.exchange,
      token: instrument.token,
      lot_size: instrument.lotsize,
      instrument_type: instrument.instrument_type,
    };
  }

  /**
   * Look up symbol in instruments cache
   * @private
   */
  async _lookupSymbol(symbol, exchange) {
    try {
      const instrument = await db.get(
        'SELECT * FROM instruments WHERE symbol = ? AND exchange = ?',
        [symbol, exchange]
      );

      if (!instrument) {
        throw new Error(`Symbol not found in instruments cache: ${symbol} on ${exchange}`);
      }

      return {
        original_symbol: symbol,
        resolved_symbol: symbol,
        exchange: instrument.exchange,
        token: instrument.token,
        lot_size: instrument.lotsize,
        instrument_type: instrument.instrument_type,
        index_name: instrument.name?.split(' ')[0], // Extract index name
      };
    } catch (error) {
      log.error('Failed to lookup symbol', error, { symbol, exchange });
      throw error;
    }
  }
}

// Export singleton instance
export default new SymbolResolverService();
export { SymbolResolverService };
