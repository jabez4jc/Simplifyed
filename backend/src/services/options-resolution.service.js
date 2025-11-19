/**
 * Options Resolution Service
 * Resolves option symbols based on underlying, expiry, strike offset
 * Handles ITM/ATM/OTM strike selection and caching
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import openalgoClient from '../integrations/openalgo/client.js';
import instrumentsService from './instruments.service.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { parseFloatSafe } from '../utils/sanitizers.js';

class OptionsResolutionService {
  /**
   * Convert expiry date from YYYY-MM-DD to DD-MMM-YY format (OpenAlgo format)
   * @param {string} expiry - Expiry in YYYY-MM-DD format
   * @returns {string} Expiry in DD-MMM-YY format
   * @private
   */
  _convertToOpenAlgoExpiryFormat(expiry) {
    if (!expiry) return null;

    // If already in DD-MMM-YY format, return as-is
    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      return expiry;
    }

    // Convert YYYY-MM-DD to DD-MMM-YY
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      const date = new Date(expiry);
      const day = String(date.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames[date.getMonth()];
      const year = String(date.getFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    }

    log.warn('Unknown expiry format in _convertToOpenAlgoExpiryFormat', { expiry });
    return expiry;
  }

  _normalizeExpiryToISO(expiry) {
    if (!expiry) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return expiry;
    }
    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      const [day, monthStr, year] = expiry.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const monthIndex = monthNames.indexOf(monthStr);
      if (monthIndex === -1) {
        return null;
      }
      const fullYear = `20${year}`;
      const paddedMonth = String(monthIndex + 1).padStart(2, '0');
      return `${fullYear}-${paddedMonth}-${day}`;
    }
    return expiry;
  }

  /**
   * Resolve option symbol for a given underlying and strike offset
   * @param {Object} params - Resolution parameters
   * @param {string} params.underlying - Underlying symbol (e.g., NIFTY, RELIANCE)
   * @param {string} params.exchange - Exchange (NFO, BSE)
   * @param {string} params.expiry - Expiry date (YYYY-MM-DD or DD-MMM-YY)
   * @param {string} params.optionType - CE or PE
   * @param {string} params.strikeOffset - ITM3, ITM2, ITM1, ATM, OTM1, OTM2, OTM3
   * @param {number} params.ltp - Current LTP of underlying
   * @param {Object} params.instance - OpenAlgo instance for fetching data
   * @returns {Promise<Object>} Resolved option symbol with details
   */
  async resolveOptionSymbol({
    underlying,
    exchange,
    expiry,
    optionType,
    strikeOffset,
    ltp,
    instance,
  }) {
    // Validate inputs
    const missingParams = [];
    if (!underlying) missingParams.push('underlying');
    if (!exchange) missingParams.push('exchange');
    if (!expiry) missingParams.push('expiry');
    if (!optionType) missingParams.push('optionType');
    if (!strikeOffset) missingParams.push('strikeOffset');
    if (!ltp || ltp === 0) missingParams.push('ltp');

    if (missingParams.length > 0) {
      throw new ValidationError(
        `Missing required parameters for option resolution: ${missingParams.join(', ')}`
      );
    }

    if (!['CE', 'PE'].includes(optionType)) {
      throw new ValidationError('optionType must be CE or PE');
    }

    const validOffsets = ['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3'];
    if (!validOffsets.includes(strikeOffset)) {
      throw new ValidationError(`strikeOffset must be one of: ${validOffsets.join(', ')}`);
    }

    log.debug('Resolving option symbol', {
      underlying,
      exchange,
      expiry,
      optionType,
      strikeOffset,
      ltp,
    });

    // Step 1: Get or fetch option chain
    const optionChain = await this._getOptionChain(underlying, exchange, expiry, instance);

    // Step 2: Calculate target strike based on LTP and offset
    const targetStrike = this._calculateTargetStrike(
      ltp,
      strikeOffset,
      optionType,
      optionChain.strikes,
      optionChain.strikeStep
    );

    // Step 3: Find the option symbol for the target strike
    const optionSymbol = this._findOptionSymbol(
      optionChain,
      targetStrike,
      optionType
    );

    if (!optionSymbol) {
      throw new NotFoundError(
        `Option symbol not found for ${underlying} ${expiry} ${targetStrike}${optionType}`
      );
    }

    log.info('Option symbol resolved', {
      underlying,
      expiry,
      optionType,
      strikeOffset,
      targetStrike,
      symbol: optionSymbol.symbol,
    });

    return {
      underlying,
      exchange,
      expiry,
      optionType,
      strikeOffset,
      targetStrike,
      strikeStep: optionChain.strikeStep,
      ...optionSymbol,
    };
  }

  /**
   * Get option chain for underlying and expiry
   * Uses cache if available, otherwise fetches from OpenAlgo
   * @private
   */
  async _getOptionChain(underlying, exchange, expiry, instance) {
    const isoExpiry = this._normalizeExpiryToISO(expiry);
    if (isoExpiry) {
      try {
        const dbChain = await this._buildOptionChainFromDb(underlying, isoExpiry, exchange);
        if (dbChain) {
          return dbChain;
        }
      } catch (error) {
        log.warn('Failed to build option chain from instruments cache', {
          underlying,
          expiry: isoExpiry,
          exchange,
          error: error.message,
        });
      }
    }

    // Convert expiry to OpenAlgo format (DD-MMM-YY) for API calls and cache lookup
    const openalgoExpiry = this._convertToOpenAlgoExpiryFormat(expiry);
    log.debug('Expiry format conversion', {
      inputExpiry: expiry,
      openalgoExpiry,
    });

    // Try to get from cache first (using OpenAlgo format)
    const cached = await this._getOptionChainFromCache(underlying, exchange, openalgoExpiry);
    if (cached && cached.length > 0) {
      log.debug('Option chain retrieved from cache', {
        underlying,
        expiry: openalgoExpiry,
        count: cached.length,
      });
      return this._processOptionChain(cached);
    }

    // Fetch from OpenAlgo as fallback
    log.debug('Fetching option chain from OpenAlgo', { underlying, expiry: openalgoExpiry });

    try {
      const chainData = await openalgoClient.getOptionChain(
        instance,
        underlying,
        openalgoExpiry, // Use OpenAlgo format
        exchange
      );

      await this._cacheOptionChain(underlying, exchange, openalgoExpiry, chainData);

      return this._processOptionChain(chainData);
    } catch (error) {
      log.error('Failed to fetch option chain from OpenAlgo', error, {
        underlying,
        expiry: openalgoExpiry,
      });

      // If OpenAlgo option chain fails, try to get symbols via search
      return await this._getOptionChainViaSearch(underlying, exchange, openalgoExpiry, instance);
    }
  }

  /**
   * Get option chain from cache
   * @private
   */
  async _getOptionChainFromCache(underlying, exchange, expiry) {
    try {
      const results = await db.all(
        `SELECT * FROM options_cache
         WHERE underlying = ? AND exchange = ? AND expiry = ?
         ORDER BY strike ASC`,
        [underlying, exchange, expiry]
      );

      return results;
    } catch (error) {
      log.error('Failed to get option chain from cache', error);
      return [];
    }
  }

  /**
   * Cache option chain data
   * @private
   */
  async _cacheOptionChain(underlying, exchange, expiry, chainData) {
    try {
      // Extract all options from chain data
      const options = this._extractOptionsFromChainData(chainData);

      for (const option of options) {
        if (!option.option_type || typeof option.option_type !== 'string') {
          log.debug('Skipping option cache because option_type is missing', {
            underlying,
            expiry,
            symbol: option.symbol,
          });
          continue;
        }
        await db.run(
          `INSERT OR REPLACE INTO options_cache (
            underlying, expiry, strike, option_type, exchange,
            symbol, trading_symbol, lot_size, tick_size,
            instrument_type, token, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            underlying,
            expiry,
            option.strike,
            option.option_type,
            exchange,
            option.symbol,
            option.trading_symbol || option.symbol,
            option.lot_size || 1,
            option.tick_size || 0.05,
            option.instrument_type || 'OPTIDX',
            option.token || null,
          ]
        );
      }

      log.debug('Cached option chain', {
        underlying,
        expiry,
        count: options.length,
      });
    } catch (error) {
      log.error('Failed to cache option chain', error);
      // Non-fatal error, continue without cache
    }
  }

  /**
   * Extract options from OpenAlgo chain data
   * Handles different broker formats
   * @private
   */
  _extractOptionsFromChainData(chainData) {
    const options = [];

    // Handle different formats from different brokers
    if (Array.isArray(chainData)) {
      // Format 1: Array of options
      return chainData;
    } else if (chainData.options && Array.isArray(chainData.options)) {
      // Format 2: { options: [...] }
      return chainData.options;
    } else if (chainData.CE && chainData.PE) {
      // Format 3: { CE: {...}, PE: {...} }
      // Iterate through strikes
      for (const [strike, ceData] of Object.entries(chainData.CE)) {
        options.push({
          ...ceData,
          strike: parseFloat(strike),
          option_type: 'CE',
        });
      }
      for (const [strike, peData] of Object.entries(chainData.PE)) {
        options.push({
          ...peData,
          strike: parseFloat(strike),
          option_type: 'PE',
        });
      }
    }

    return options;
  }

  /**
   * Get option chain via search (fallback method)
   * @private
   */
  async _getOptionChainViaSearch(underlying, exchange, expiry, instance) {
    log.debug('Fetching options via search (fallback)', { underlying, expiry });

    try {
      // Search for the underlying symbol with expiry
      const searchQuery = underlying;
      const searchResults = await openalgoClient.searchSymbols(instance, searchQuery);

      log.debug('Search results for option chain', {
        underlying,
        expiry,
        totalResults: searchResults.length,
        sampleExpiries: searchResults.slice(0, 5).map(r => r.expiry)
      });

      // Filter for options with matching expiry
      const options = searchResults.filter(result => {
        // Options have instrumenttype as 'CE' or 'PE', not 'OPT'
        const isOption = result.instrumenttype === 'CE' || result.instrumenttype === 'PE';
        const matchesExpiry = result.expiry === expiry;
        const matchesUnderlying = result.name === underlying;
        return isOption && matchesExpiry && matchesUnderlying;
      });

      if (options.length === 0) {
        log.warn('No matching options found after filtering', {
          underlying,
          requestedExpiry: expiry,
          uniqueExpiriesInResults: [...new Set(searchResults
            .filter(r => r.instrumenttype === 'CE' || r.instrumenttype === 'PE')
            .map(r => r.expiry))]
        });
        throw new NotFoundError(`No options found for ${underlying} with expiry ${expiry}`);
      }

      log.debug('Found options via search', {
        underlying,
        expiry,
        optionsCount: options.length
      });

      // Cache these options
      await this._cacheOptionChain(underlying, exchange, expiry, options);

      return this._processOptionChain(options);
    } catch (error) {
      log.error('Failed to get option chain via search', error);
      // If error is already a NotFoundError, just re-throw it to avoid duplication
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new NotFoundError(
        `Unable to fetch option chain for ${underlying} ${expiry}: ${error.message}`
      );
    }
  }

  async _buildOptionChainFromDb(underlying, expiry, exchange) {
    try {
      const chain = await instrumentsService.buildOptionChain(
        underlying,
        expiry,
        exchange
      );

      if (!chain || !Array.isArray(chain.strikes) || chain.strikes.length === 0) {
        return null;
      }

      const strikes = chain.strikes
        .map(entry => entry.strike)
        .filter(strike => typeof strike === 'number')
        .sort((a, b) => a - b);

      if (strikes.length === 0) {
        return null;
      }

      const optionsByStrike = {};
      chain.strikes.forEach(entry => {
        if (typeof entry.strike !== 'number') return;
        optionsByStrike[entry.strike] = optionsByStrike[entry.strike] || { CE: null, PE: null };
        if (entry.ce) {
          optionsByStrike[entry.strike].CE = this._normalizeInstrumentOption(entry.ce);
        }
        if (entry.pe) {
          optionsByStrike[entry.strike].PE = this._normalizeInstrumentOption(entry.pe);
        }
      });

      let strikeStep = 0;
      if (strikes.length >= 2) {
        const diffs = [];
        for (let i = 1; i < strikes.length; i++) {
          diffs.push(strikes[i] - strikes[i - 1]);
        }
        strikeStep = this._mostCommon(diffs);
      }

      log.debug('Option chain resolved from instruments cache', {
        underlying,
        expiry,
        exchange,
        strikes: strikes.length,
      });

      return {
        strikes,
        strikeStep,
        optionsByStrike,
      };
    } catch (error) {
      log.warn('Failed to build option chain from instruments cache', {
        underlying,
        expiry,
        exchange,
        error: error.message,
      });
      return null;
    }
  }

  _normalizeInstrumentOption(option) {
    if (!option) return null;
    const symbol = option.symbol || option.tradingsymbol || '';
    let optionType =
      (option.instrumenttype || '').toUpperCase() ||
      (symbol.toUpperCase().endsWith('PE') ? 'PE' : symbol.toUpperCase().endsWith('CE') ? 'CE' : null);

    if (!optionType) {
      optionType = 'CE';
    }

    return {
      symbol,
      trading_symbol: symbol,
      strike: option.strike,
      option_type: optionType,
      lot_size: option.lotsize || option.lot_size || option.lotSize || 1,
      tick_size: option.tick_size || option.tickSize || 0.05,
      exchange: option.exchange,
      token: option.token || null,
    };
  }

  /**
   * Process option chain data to extract strikes and determine strike step
   * @private
   */
  _processOptionChain(chainData) {
    const options = this._extractOptionsFromChainData(chainData);

    if (options.length === 0) {
      throw new NotFoundError('Option chain is empty');
    }

    // Extract unique strikes and sort them
    const strikes = [...new Set(options.map(opt => parseFloatSafe(opt.strike, 0)))]
      .filter(s => s > 0)
      .sort((a, b) => a - b);

    // Calculate strike step (difference between consecutive strikes)
    let strikeStep = 50; // Default
    if (strikes.length >= 2) {
      const differences = [];
      for (let i = 1; i < strikes.length; i++) {
        differences.push(strikes[i] - strikes[i - 1]);
      }
      // Use the most common difference
      strikeStep = this._mostCommon(differences);
    }

    // Group options by strike for easy lookup
    const optionsByStrike = {};
    for (const option of options) {
      const strike = parseFloatSafe(option.strike, 0);
      if (!optionsByStrike[strike]) {
        optionsByStrike[strike] = { CE: null, PE: null };
      }

      const optType = option.option_type || (option.symbol.includes('CE') ? 'CE' : 'PE');
      optionsByStrike[strike][optType] = {
        symbol: option.symbol,
        trading_symbol: option.trading_symbol || option.tradingsymbol || option.symbol,
        lot_size: option.lot_size || option.lotsize || 1,  // Handle both lot_size and lotsize
        tick_size: option.tick_size || 0.05,
        instrument_type: option.instrument_type || option.instrumenttype,
        token: option.token,
      };
    }

    return {
      strikes,
      strikeStep,
      optionsByStrike,
    };
  }

  /**
   * Calculate target strike based on LTP and offset
   * @private
   */
  _calculateTargetStrike(ltp, strikeOffset, optionType, strikes, strikeStep) {
    // Find ATM strike (closest to LTP)
    const atmStrike = this._findATMStrike(ltp, strikes);

    // Calculate offset based on strikeOffset parameter
    const offsetMap = {
      ITM3: optionType === 'CE' ? -3 : 3,
      ITM2: optionType === 'CE' ? -2 : 2,
      ITM1: optionType === 'CE' ? -1 : 1,
      ATM: 0,
      OTM1: optionType === 'CE' ? 1 : -1,
      OTM2: optionType === 'CE' ? 2 : -2,
      OTM3: optionType === 'CE' ? 3 : -3,
    };

    const offset = offsetMap[strikeOffset];
    const targetStrike = atmStrike + (offset * strikeStep);

    // Find the closest available strike
    return this._findClosestStrike(targetStrike, strikes);
  }

  /**
   * Find ATM strike (closest to LTP)
   * @private
   */
  _findATMStrike(ltp, strikes) {
    let closest = strikes[0];
    let minDiff = Math.abs(ltp - closest);

    for (const strike of strikes) {
      const diff = Math.abs(ltp - strike);
      if (diff < minDiff) {
        minDiff = diff;
        closest = strike;
      }
    }

    return closest;
  }

  /**
   * Find closest available strike
   * @private
   */
  _findClosestStrike(targetStrike, strikes) {
    return this._findATMStrike(targetStrike, strikes);
  }

  /**
   * Find option symbol for strike and type
   * @private
   */
  _findOptionSymbol(optionChain, strike, optionType) {
    const options = optionChain.optionsByStrike[strike];
    if (!options || !options[optionType]) {
      return null;
    }

    return options[optionType];
  }

  /**
   * Find most common value in array
   * @private
   */
  _mostCommon(arr) {
    const counts = {};
    let maxCount = 0;
    let mostCommon = arr[0];

    for (const val of arr) {
      counts[val] = (counts[val] || 0) + 1;
      if (counts[val] > maxCount) {
        maxCount = counts[val];
        mostCommon = val;
      }
    }

    return mostCommon;
  }

  /**
   * Batch resolve multiple option symbols
   * @param {Array<Object>} requests - Array of resolution requests
   * @returns {Promise<Array<Object>>} Resolved symbols
   */
  async batchResolveOptions(requests) {
    const results = await Promise.allSettled(
      requests.map(req => this.resolveOptionSymbol(req))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          success: true,
          data: result.value,
          request: requests[index],
        };
      } else {
        return {
          success: false,
          error: result.reason.message,
          request: requests[index],
        };
      }
    });
  }

  /**
   * Clear option cache for specific underlying and expiry
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {string} expiry - Expiry date
   */
  async clearCache(underlying, exchange, expiry) {
    try {
      await db.run(
        'DELETE FROM options_cache WHERE underlying = ? AND exchange = ? AND expiry = ?',
        [underlying, exchange, expiry]
      );

      log.info('Cleared option cache', { underlying, exchange, expiry });
    } catch (error) {
      log.error('Failed to clear option cache', error);
    }
  }

  /**
   * Get all cached strikes for an underlying and expiry
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {string} expiry - Expiry date
   * @returns {Promise<Array<number>>} Array of strikes
   */
  async getCachedStrikes(underlying, exchange, expiry) {
    try {
      const results = await db.all(
        `SELECT DISTINCT strike FROM options_cache
         WHERE underlying = ? AND exchange = ? AND expiry = ?
         ORDER BY strike ASC`,
        [underlying, exchange, expiry]
      );

      return results.map(r => r.strike);
    } catch (error) {
      log.error('Failed to get cached strikes', error);
      return [];
    }
  }
}

// Export singleton instance
export default new OptionsResolutionService();
export { OptionsResolutionService };
