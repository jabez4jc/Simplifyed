/**
 * Symbol Resolution Service
 * Centralizes symbol validation, search, and underlying/exchange normalization.
 */

import instrumentsService from './instruments.service.js';
import derivativeResolutionService from './derivative-resolution.service.js';

class SymbolResolutionService {
  normalizeSymbol(symbol) {
    if (!symbol) return '';
    return String(symbol).trim().toUpperCase();
  }

  normalizeExchange(exchange) {
    if (!exchange) return '';
    return String(exchange).trim().toUpperCase();
  }

  /**
   * Resolve underlying + derivative exchange for a watchlist symbol.
   */
  resolveUnderlyingAndExchange(symbolRow = {}) {
    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbolRow);
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbolRow.exchange);
    return { underlying, derivativeExchange };
  }

  /**
   * Validate symbol exists in instruments cache for a given exchange.
   * Falls back to simple normalization if instruments table is unavailable.
   */
  async validateSymbol(symbol, exchange) {
    const sym = this.normalizeSymbol(symbol);
    const exch = this.normalizeExchange(exchange);
    if (!sym || !exch) return { valid: false, message: 'symbol/exchange required' };

    try {
      const match = await instrumentsService.findInstrument(sym, exch);
      if (match) {
        return { valid: true, instrument: match };
      }
      return { valid: false, message: 'Symbol not found in instruments cache' };
    } catch (error) {
      return { valid: false, message: error.message };
    }
  }

  /**
   * Search instruments for symbols matching query and exchange.
   */
  async searchSymbols(query, exchange) {
    const q = (query || '').trim();
    if (!q) return [];
    return instrumentsService.searchInstruments(q, exchange);
  }
}

const symbolResolutionService = new SymbolResolutionService();
export default symbolResolutionService;
