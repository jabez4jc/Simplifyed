/**
 * Derivative Resolution Service
 * Normalizes underlyings, maps exchanges, and resolves futures contracts
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';
import { NotFoundError } from '../core/errors.js';
import { toDisplay, sameExpiry } from '../utils/expiry.js';

export const NSE_INDEX_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
export const BSE_INDEX_UNDERLYINGS = new Set(['SENSEX', 'BANKEX']);

class DerivativeResolutionService {
  getDerivativeExchange(exchange) {
    const exchangeMap = {
      NSE: 'NFO',
      NSE_INDEX: 'NFO',
      BSE: 'BFO',
      BSE_INDEX: 'BFO',
      NFO: 'NFO',
      BFO: 'BFO',
      MCX: 'MCX',
      CDS: 'CDS',
    };
    if (!exchange) return 'NFO';
    return exchangeMap[exchange] || exchange;
  }

  /**
   * Strip a trading symbol/name down to its plain underlying, e.g.
   * "NATURALGAS 28 JUL 26 FUT" -> "NATURALGAS", "BANKNIFTY25NOV2558000CE" -> "BANKNIFTY".
   * Broker symbols/names embed a DDMMMYY-style expiry (e.g. 28JUL26) followed by an optional
   * strike and a CE/PE/FUT suffix - naive trailing-digit stripping breaks on this because the
   * suffix is letters, not digits, so this matches the date pattern directly instead.
   * (Mirrors extractUnderlying() in public/js/quick-order.js - keep both in sync.)
   */
  _normalizeToUnderlying(value) {
    const upper = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return '';
    const dateMatch = upper.match(/^([A-Z]+)\d{1,2}[A-Z]{3}\d{2,4}/);
    if (dateMatch) {
      return dateMatch[1];
    }
    return upper.replace(/\d+$/, '');
  }

  getDerivativeUnderlying(symbol = {}) {
    const exchange = (symbol.exchange || '').toUpperCase();

    // Normalize underlying_symbol too, not just the raw-symbol fallback: it's supposed to be a
    // clean, human-curated name, but some watchlist rows (notably MCX ones added before this fix)
    // have it populated with a full contract identifier instead (e.g. "NATURALGAS 28 Jul 26 FUT"
    // instead of "NATURALGAS"). Normalizing is a safe no-op for genuinely clean names - it only
    // changes anything when a recognizable date/strike/CE/PE/FUT pattern is actually present.
    if (symbol.underlying_symbol) {
      const cleaned = this._normalizeToUnderlying(symbol.underlying_symbol);
      return cleaned || String(symbol.underlying_symbol).trim().toUpperCase();
    }

    const base = (symbol.symbol || symbol.name || '').trim();
    if (!base) {
      return '';
    }

    if ((symbol.symbol_type || '').toUpperCase() === 'INDEX' || exchange.endsWith('_INDEX')) {
      return this._normalizeToUnderlying(symbol.symbol || base) || this._normalizeToUnderlying(base);
    }

    return this._normalizeToUnderlying(base) || base.toUpperCase();
  }

  getUnderlyingForClosing(symbol = {}) {
    const derived = this.getDerivativeUnderlying(symbol);
    if (derived) {
      return derived;
    }
    const candidate = (symbol.symbol || symbol.trading_symbol || symbol.name || '').toUpperCase();
    return this._normalizeToUnderlying(candidate) || candidate;
  }

  async resolveFuturesSymbol(instance, underlying, exchange, expiry) {
    try {
      const openalgoExpiry = toDisplay(expiry) || expiry;
      log.debug('Searching for futures symbol', { underlying, exchange, expiry: openalgoExpiry });

      const searchResults = await openalgoClient.searchSymbols(instance, underlying);
      const normalizedUnderlying = underlying.replace(/\s+/g, '').toUpperCase();

      const futuresSymbols = searchResults.filter((result) => {
        const instrumentType = (result.instrumenttype || '').toUpperCase();
        const isFutures = instrumentType.startsWith('FUT') || instrumentType === 'PERPFUT';
        const resultKey = this._deriveUnderlyingKeyFromInstrumentData(
          result.symbol,
          instrumentType,
          result.name
        );
        const matchesUnderlying = resultKey === normalizedUnderlying;
        const matchesExpiry = !expiry
          || sameExpiry(result.expiry, expiry)
          || sameExpiry(this._extractExpiryFromSymbol(result.symbol), expiry);
        const matchesExchange = (result.exchange || '').toUpperCase() === (exchange || '').toUpperCase();
        return isFutures && matchesUnderlying && matchesExpiry && matchesExchange;
      });

      if (futuresSymbols.length === 0) {
        throw new NotFoundError(
          `No futures contract found for ${underlying} with expiry ${openalgoExpiry}`
        );
      }

      const futuresSymbol = futuresSymbols[0];
      log.info('Futures symbol found', {
        symbol: futuresSymbol.symbol,
        lotSize: futuresSymbol.lotsize || futuresSymbol.lot_size,
        expiry: futuresSymbol.expiry,
      });

      return {
        symbol: futuresSymbol.symbol,
        trading_symbol: futuresSymbol.tradingsymbol || futuresSymbol.symbol,
        lot_size: futuresSymbol.lotsize || futuresSymbol.lot_size || 1,
        tick_size: futuresSymbol.tick_size || 0.05,
        token: futuresSymbol.token,
        expiry: futuresSymbol.expiry,
      };
    } catch (error) {
      log.error('Failed to resolve futures symbol', error);
      throw new NotFoundError(
        `Unable to find futures contract for ${underlying} with expiry ${expiry}: ${error.message}`
      );
    }
  }

  _deriveUnderlyingKeyFromInstrumentData(symbol, instrumentType, name) {
    const sym = (symbol || '').toUpperCase().replace(/\s+/g, '');
    const instType = (instrumentType || '').toUpperCase();
    const nm = (name || '').toUpperCase();
    if (!sym) {
      return nm || null;
    }
    const isDerivative = instType.startsWith('FUT') || instType.startsWith('OPT');
    if (!isDerivative) {
      return sym;
    }
    const cleaned = sym.replace(/[^A-Z0-9]/g, '');
    const match = cleaned.match(/^([A-Z]+)/);
    if (match && match[1]) {
      return match[1];
    }
    if (nm) {
      return nm.replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '');
    }
    return cleaned;
  }

  _extractExpiryFromSymbol(symbol) {
    const normalized = (symbol || '').toUpperCase().replace(/\s+/g, '');
    const match = normalized.match(/\d{2}[A-Z]{3}\d{2}(?=FUT$)/);
    return match ? match[0] : null;
  }
}

const derivativeResolutionService = new DerivativeResolutionService();
export default derivativeResolutionService;
