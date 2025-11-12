/**
 * Symbol Classification Service
 * Analyzes OpenAlgo search results to determine tradability:
 * - Equity-only symbols
 * - F&O-eligible symbols (Futures/Options)
 * - Classification by instrument type
 */

import { log } from '../core/logger.js';

class SymbolClassificationService {
  /**
   * Classify a symbol based on OpenAlgo search results
   * @param {Array} searchResults - Array of search results from OpenAlgo
   * @param {string} query - Original search query
   * @returns {Object} Classification result
   */
  classifySymbol(searchResults, query) {
    if (!searchResults || searchResults.length === 0) {
      return {
        query,
        tradable_equity: false,
        tradable_futures: false,
        tradable_options: false,
        classification: 'UNKNOWN',
        underlying: null,
        reason: 'No search results',
      };
    }

    // Group results by name
    const groupedByName = this._groupByName(searchResults);

    // Find the most relevant group (exact match or closest match)
    const relevantGroup = this._findRelevantGroup(groupedByName, query);

    if (!relevantGroup || relevantGroup.length === 0) {
      return {
        query,
        tradable_equity: false,
        tradable_futures: false,
        tradable_options: false,
        classification: 'UNKNOWN',
        underlying: null,
        reason: 'No relevant results',
      };
    }

    // Analyze the group to determine tradability
    return this._analyzeGroup(relevantGroup, query);
  }

  /**
   * Group search results by symbol name
   * @private
   */
  _groupByName(results) {
    const groups = {};

    for (const result of results) {
      const name = result.name || result.symbol;
      if (!groups[name]) {
        groups[name] = [];
      }
      groups[name].push(result);
    }

    return groups;
  }

  /**
   * Find the most relevant group based on query
   * @private
   */
  _findRelevantGroup(groupedByName, query) {
    const queryUpper = query.toUpperCase();

    // First, try exact match on name
    for (const [name, results] of Object.entries(groupedByName)) {
      if (name.toUpperCase() === queryUpper) {
        return results;
      }
    }

    // Then, try exact match on symbol
    for (const [_, results] of Object.entries(groupedByName)) {
      for (const result of results) {
        if (result.symbol.toUpperCase() === queryUpper) {
          return [result]; // Return single result for exact symbol match
        }
      }
    }

    // Finally, try partial match on name (for equity symbols like RELIANCE)
    for (const [name, results] of Object.entries(groupedByName)) {
      if (name.toUpperCase().includes(queryUpper) || queryUpper.includes(name.toUpperCase())) {
        return results;
      }
    }

    // Return the first group as fallback
    return Object.values(groupedByName)[0] || [];
  }

  /**
   * Analyze a group of results to determine tradability
   * @private
   */
  _analyzeGroup(results, query) {
    const classification = {
      query,
      tradable_equity: false,
      tradable_futures: false,
      tradable_options: false,
      classification: 'UNKNOWN',
      underlying: null,
      instruments: [],
      reason: '',
    };

    // Check for different instrument types
    const hasEquity = results.some(r => this._isEquity(r));
    const hasFutures = results.some(r => this._isFutures(r));
    const hasOptions = results.some(r => this._isOptions(r));

    // Determine tradability
    classification.tradable_equity = hasEquity;
    classification.tradable_futures = hasFutures;
    classification.tradable_options = hasOptions;

    // Extract underlying symbol
    classification.underlying = this._extractUnderlying(results);

    // Classify based on available instruments
    // Check more specific cases first, then general cases
    if (hasEquity && !hasFutures && !hasOptions) {
      classification.classification = 'EQUITY_ONLY';
      classification.reason = 'Pure equity symbol (no F&O)';
    } else if (hasEquity && (hasFutures || hasOptions)) {
      classification.classification = 'EQUITY_FNO';
      classification.reason = 'Equity with F&O eligibility';
    } else if (hasFutures && hasOptions && !hasEquity) {
      // INDEX: Has both futures and options but no equity
      classification.classification = 'INDEX';
      classification.reason = 'Index (Futures/Options only)';
    } else if (hasFutures && !hasEquity && !hasOptions) {
      // FUTURES_ONLY: Only futures, no options
      classification.classification = 'FUTURES_ONLY';
      classification.reason = 'Futures-only symbol';
    } else if (hasOptions && !hasEquity && !hasFutures) {
      // OPTIONS_ONLY: Direct option contract
      classification.classification = 'OPTIONS_ONLY';
      classification.reason = 'Direct option contract';
    }

    // Store instrument details for reference
    classification.instruments = results.map(r => ({
      symbol: r.symbol,
      exchange: r.exchange,
      instrumenttype: r.instrumenttype,
      expiry: r.expiry,
      strike: r.strike,
      option_type: r.option_type,
    }));

    log.debug('Symbol classification', classification);

    return classification;
  }

  /**
   * Check if result is an equity instrument
   * @private
   */
  _isEquity(result) {
    // Equity characteristics:
    // - instrumenttype: EQ, EQUITY, or similar
    // - No expiry date
    // - Name equals symbol (or very similar)

    const instrumentType = (result.instrumenttype || result.instrument_type || '').toUpperCase();
    const hasExpiry = result.expiry && result.expiry.trim() !== '';

    // Check instrument type
    if (instrumentType === 'EQ' || instrumentType === 'EQUITY') {
      return true;
    }

    // If no expiry and name == symbol, likely equity
    if (!hasExpiry && result.name && result.symbol) {
      // Remove common suffixes for comparison
      const nameClean = result.name.replace(/-EQ$/i, '').trim();
      const symbolClean = result.symbol.replace(/-EQ$/i, '').trim();

      if (nameClean.toUpperCase() === symbolClean.toUpperCase()) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if result is a futures instrument
   * @private
   */
  _isFutures(result) {
    // Futures characteristics:
    // - instrumenttype: FUTIDX, FUTSTK, or similar
    // - Has expiry date
    // - Symbol contains FUT or expiry pattern

    const instrumentType = (result.instrumenttype || result.instrument_type || '').toUpperCase();
    const symbol = result.symbol.toUpperCase();
    const hasExpiry = result.expiry && result.expiry.trim() !== '';

    // Check instrument type
    if (instrumentType.includes('FUT')) {
      return true;
    }

    // Check symbol pattern (e.g., NIFTY25NOVFUT)
    if (hasExpiry && symbol.includes('FUT')) {
      return true;
    }

    return false;
  }

  /**
   * Check if result is an options instrument
   * @private
   */
  _isOptions(result) {
    // Options characteristics:
    // - instrumenttype: OPTIDX, OPTSTK, or similar
    // - Has expiry date
    // - Has strike price
    // - Symbol contains CE or PE

    const instrumentType = (result.instrumenttype || result.instrument_type || '').toUpperCase();
    const symbol = result.symbol.toUpperCase();
    const hasExpiry = result.expiry && result.expiry.trim() !== '';
    const hasStrike = result.strike !== null && result.strike !== undefined;

    // Check instrument type
    if (instrumentType.includes('OPT')) {
      return true;
    }

    // Check symbol pattern (e.g., NIFTY25NOV25000CE)
    if (hasExpiry && hasStrike && (symbol.includes('CE') || symbol.includes('PE'))) {
      return true;
    }

    // Check if option_type is set
    if (result.option_type && (result.option_type === 'CE' || result.option_type === 'PE')) {
      return true;
    }

    return false;
  }

  /**
   * Extract underlying symbol from results
   * @private
   */
  _extractUnderlying(results) {
    // For equity, underlying is the equity symbol itself
    const equityResult = results.find(r => this._isEquity(r));
    if (equityResult) {
      return equityResult.symbol.replace(/-EQ$/i, '').trim();
    }

    // For F&O, extract from name (remove expiry/strike/CE/PE)
    const fnoResult = results.find(r => this._isFutures(r) || this._isOptions(r));
    if (fnoResult && fnoResult.name) {
      return fnoResult.name.trim();
    }

    // Fallback: use first symbol
    return results[0].symbol.replace(/-EQ$/i, '').trim();
  }

  /**
   * Determine control availability based on classification
   * @param {Object} classification - Classification result from classifySymbol
   * @returns {Object} Control availability
   */
  getControlAvailability(classification) {
    const controls = {
      show_equity_toggle: false,
      show_futures_toggle: false,
      show_options_controls: false,
      default_mode: 'EQUITY',
    };

    switch (classification.classification) {
      case 'EQUITY_ONLY':
        // BUY, SELL, EXIT only
        controls.show_equity_toggle = false;
        controls.show_futures_toggle = false;
        controls.show_options_controls = false;
        controls.default_mode = 'EQUITY';
        break;

      case 'EQUITY_FNO':
        // Equity/Futures toggle + Options controls
        controls.show_equity_toggle = true;
        controls.show_futures_toggle = true;
        controls.show_options_controls = true;
        controls.default_mode = 'EQUITY';
        break;

      case 'FUTURES_ONLY':
      case 'INDEX':
        // Futures + Options controls (no equity)
        controls.show_equity_toggle = false;
        controls.show_futures_toggle = true;
        controls.show_options_controls = classification.tradable_options;
        controls.default_mode = 'FUTURES';
        break;

      case 'OPTIONS_ONLY':
        // Treat like equity (BUY, SELL, EXIT)
        controls.show_equity_toggle = false;
        controls.show_futures_toggle = false;
        controls.show_options_controls = false;
        controls.default_mode = 'OPTIONS';
        break;

      default:
        // Unknown - show nothing
        controls.show_equity_toggle = false;
        controls.show_futures_toggle = false;
        controls.show_options_controls = false;
        controls.default_mode = 'EQUITY';
    }

    return controls;
  }
}

// Export singleton instance
export default new SymbolClassificationService();
export { SymbolClassificationService };
