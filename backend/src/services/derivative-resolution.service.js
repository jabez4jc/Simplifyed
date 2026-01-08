/**
 * Derivative Resolution Service
 * Normalizes underlyings, maps exchanges, and resolves futures contracts
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';
import { NotFoundError } from '../core/errors.js';

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

  getDerivativeUnderlying(symbol = {}) {
    const exchange = (symbol.exchange || '').toUpperCase();
    const base = (symbol.underlying_symbol || symbol.symbol || symbol.name || '').trim();
    if (!base) {
      return '';
    }

    const normalize = (value) => value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/\d+$/, '');

    if ((symbol.symbol_type || '').toUpperCase() === 'INDEX' || exchange.endsWith('_INDEX')) {
      const cleaned = normalize(symbol.symbol || base);
      return cleaned || normalize(base);
    }

    return base.toUpperCase();
  }

  getUnderlyingForClosing(symbol = {}) {
    const derived = this.getDerivativeUnderlying(symbol);
    if (derived) {
      return derived;
    }
    const candidate = (symbol.symbol || symbol.trading_symbol || symbol.name || '').toUpperCase();
    return candidate.replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '') || candidate;
  }

  convertExpiryToOpenAlgoFormat(expiry) {
    if (!expiry) return null;
    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      return expiry;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      const date = new Date(expiry);
      const day = String(date.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames[date.getMonth()];
      const year = String(date.getFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    }
    return expiry;
  }

  expandExpiryFormats(expiry) {
    if (!expiry) return [];
    const variants = new Set();
    const upper = String(expiry).toUpperCase().trim();
    variants.add(upper);

    if (/^\d{4}-\d{2}-\d{2}$/.test(upper)) {
      const d = new Date(upper);
      const day = String(d.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const mon = monthNames[d.getMonth()];
      const yy = String(d.getFullYear()).slice(-2);
      variants.add(`${day}-${mon}-${yy}`);
      variants.add(`${day}${mon}${yy}`);
    }

    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(upper)) {
      const [day, mon, yy] = upper.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const idx = monthNames.indexOf(mon);
      if (idx >= 0) {
        const yyyy = `20${yy}`;
        const month = String(idx + 1).padStart(2, '0');
        variants.add(`${yyyy}-${month}-${day}`);
        variants.add(`${day}${mon}${yy}`);
      }
    }

    if (/^\d{2}[A-Z]{3}\d{2}$/.test(upper)) {
      const day = upper.slice(0, 2);
      const mon = upper.slice(2, 5);
      const yy = upper.slice(5, 7);
      variants.add(`${day}-${mon}-${yy}`);
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const idx = monthNames.indexOf(mon);
      if (idx >= 0) {
        const yyyy = `20${yy}`;
        const month = String(idx + 1).padStart(2, '0');
        variants.add(`${yyyy}-${month}-${day}`);
      }
    }

    return Array.from(variants);
  }

  async resolveFuturesSymbol(instance, underlying, exchange, expiry) {
    try {
      const expiryVariants = this.expandExpiryFormats(expiry);
      const openalgoExpiry = this.convertExpiryToOpenAlgoFormat(expiry);
      log.debug('Searching for futures symbol', { underlying, exchange, expiry: openalgoExpiry });

      const searchResults = await openalgoClient.searchSymbols(instance, underlying);
      const normalizedUnderlying = underlying.replace(/\s+/g, '').toUpperCase();

      const futuresSymbols = searchResults.filter((result) => {
        const instrumentType = (result.instrumenttype || '').toUpperCase();
        const isFutures = instrumentType.startsWith('FUT');
        const resultKey = this._deriveUnderlyingKeyFromInstrumentData(
          result.symbol,
          instrumentType,
          result.name
        );
        const matchesUnderlying = resultKey === normalizedUnderlying;
        const resultExpiryVariants = this._resolveExpiryVariants(result);
        const matchesExpiry = expiryVariants.length === 0
          ? true
          : resultExpiryVariants.some((variant) => expiryVariants.includes(variant));
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

  _resolveExpiryVariants(result = {}) {
    const variants = new Set();
    if (result.expiry) {
      this.expandExpiryFormats(result.expiry).forEach((value) => variants.add(value));
    }

    const extracted = this._extractExpiryFromSymbol(result.symbol);
    if (extracted) {
      this.expandExpiryFormats(extracted).forEach((value) => variants.add(value));
    }

    return Array.from(variants);
  }

  _extractExpiryFromSymbol(symbol) {
    const normalized = (symbol || '').toUpperCase().replace(/\s+/g, '');
    const match = normalized.match(/\d{2}[A-Z]{3}\d{2}(?=FUT$)/);
    return match ? match[0] : null;
  }
}

const derivativeResolutionService = new DerivativeResolutionService();
export default derivativeResolutionService;
