/**
 * Option Chain Service
 * Builds option chains from instruments data
 * Uses underlying_key field for consistent underlying identification
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataInstanceService from './market-data-instance.service.js';
import instrumentsService from './instruments.service.js';
import {
  parseExpiryToYearFraction,
  riskFreeRateForSymbol,
  dividendYieldForSymbol,
  normalizeLeg,
  buildGreeksForRows,
  nearestStrikeToSpot,
  stripDerivativeSuffix,
} from '../utils/black76-pricing.util.js';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';
import { toISO, toBroker } from '../utils/expiry.js';

async function enrichWithQuotes(rows, exchangeLabel) {
  try {
    const quoteExchange = exchangeLabel === 'NSE_INDEX' ? 'NFO' : exchangeLabel;
    // Only instances whose broker trades this segment: a BTC chain priced via Kotak (or NIFTY via
    // Delta) is a per-strike "Symbol not found".
    const crypto = isCryptoExchange(quoteExchange);
    const pool = (await marketDataInstanceService.getPoolForEndpoint('multiquotes'))
      .filter((inst) => isCryptoBroker(inst.broker) === crypto);
    if (!pool.length) return rows;

    const healthy = pool.filter((i) => i.health_status === 'healthy');
    const supportsMulti = (inst) => inst.supports_multiquotes;
    const instance =
      healthy.find(supportsMulti) ||
      healthy[0] ||
      pool.find(supportsMulti) ||
      pool[0];
    if (!instance) return rows;

    const symbols = [];
    rows.forEach((r) => {
      if (r.ce?.symbol) symbols.push({ symbol: r.ce.symbol, exchange: quoteExchange });
      if (r.pe?.symbol) symbols.push({ symbol: r.pe.symbol, exchange: quoteExchange });
    });
    if (!symbols.length) return rows;

    const quotes = await openalgoClient.getMultiQuotes(instance, symbols, { returnErrors: true });
    const map = new Map();
    quotes.quotes?.forEach((q) => {
      map.set(`${q.symbol}|${q.exchange}`, q);
    });

    return rows.map((r) => {
      const ceKey = r.ce?.symbol ? `${r.ce.symbol}|${quoteExchange}` : null;
      const peKey = r.pe?.symbol ? `${r.pe.symbol}|${quoteExchange}` : null;
      const ceQuote = ceKey ? map.get(ceKey) : null;
      const peQuote = peKey ? map.get(peKey) : null;
      return {
        ...r,
        ce: r.ce
          ? {
              ...r.ce,
              ltp: ceQuote?.ltp ?? r.ce.ltp,
              bid: ceQuote?.best_bid_price ?? ceQuote?.bid ?? r.ce.bid,
              ask: ceQuote?.best_ask_price ?? ceQuote?.ask ?? r.ce.ask,
              volume: ceQuote?.volume ?? ceQuote?.traded_volume ?? r.ce.volume,
              oi: ceQuote?.open_interest ?? ceQuote?.oi ?? r.ce.oi,
            }
          : null,
        pe: r.pe
          ? {
              ...r.pe,
              ltp: peQuote?.ltp ?? peQuote?.last_price ?? peQuote?.trade_price ?? r.pe.ltp,
              bid: peQuote?.best_bid_price ?? peQuote?.bid ?? r.pe.bid,
              ask: peQuote?.best_ask_price ?? peQuote?.ask ?? r.pe.ask,
              volume: peQuote?.volume ?? peQuote?.traded_volume ?? r.pe.volume,
              oi: peQuote?.open_interest ?? peQuote?.oi ?? r.pe.oi,
            }
          : null,
      };
    });
  } catch (err) {
    log.warn('Failed to enrich option chain with quotes', { error: err.message });
    return rows;
  }
}

async function resolveSpotQuote(underlying, exchangeLabel, fallbackSpot = null) {
  try {
    const pool = await marketDataInstanceService.getPoolForEndpoint('quotes');
    if (!pool.length) return fallbackSpot;
    const healthy = pool.filter((i) => i.health_status === 'healthy');
    const supportsQuotes = (inst) => inst.supports_quotes !== false;
    const instance =
      healthy.find(supportsQuotes) ||
      healthy[0] ||
      pool.find(supportsQuotes) ||
      pool[0];
    if (!instance) return fallbackSpot;

    const candidates = [underlying];
    const stripped = stripDerivativeSuffix(underlying);
    if (stripped && stripped !== underlying) candidates.push(stripped);
    if (underlying && !underlying.endsWith('MINI')) candidates.push(`${underlying}MINI`);

    for (const sym of candidates) {
      const symbols = [{ symbol: sym, exchange: exchangeLabel }];
      const { quotes } = await openalgoClient.getQuotes(instance, symbols, { returnErrors: true, skipBackoff: true });
      const q = quotes && quotes[0];
      const ltp =
        Number(q?.ltp ?? q?.last_price ?? q?.trade_price ?? q?.price ?? q?.close ?? 0);
      if (ltp > 0) return ltp;
    }
    return fallbackSpot;
  } catch (err) {
    log.warn('Failed to resolve spot quote for option chain', { underlying, error: err.message });
    return fallbackSpot;
  }
}

class OptionChainService {
  constructor() {
    this.cache = new Map(); // key: underlying|expiry|includeQuotes -> { data, ts }
    this.cacheTtlMs = 30000; // 30s
  }

  _cacheKey(underlying, expiry, includeQuotes, forwardSource = 'carry') {
    return `${underlying}|${expiry}|${includeQuotes ? 'quotes' : 'plain'}|${forwardSource}`;
  }

  _hasPrices(rows) {
    return Array.isArray(rows)
      && rows.some(
        (r) =>
          Number(r?.ce?.ltp || r?.ce?.bid || r?.ce?.ask || 0) > 0 ||
          Number(r?.pe?.ltp || r?.pe?.bid || r?.pe?.ask || 0) > 0
      );
  }

  _getCached(underlying, expiry, includeQuotes, forwardSource = 'carry') {
    if (includeQuotes) return null; // always refresh live data
    const key = this._cacheKey(underlying, expiry, includeQuotes, forwardSource);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    // If includeQuotes, ensure cached data has real prices; otherwise ignore
    if (includeQuotes && !this._hasPrices(entry.data?.rows)) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(underlying, expiry, includeQuotes, data, forwardSource = 'carry') {
    if (includeQuotes) return; // do not cache live chains; force refresh each time
    const key = this._cacheKey(underlying, expiry, includeQuotes, forwardSource);
    this.cache.set(key, { data, ts: Date.now() });
  }
  /**
   * Get available expiries for an underlying
   * @param {string} underlying - Underlying symbol
   * @param {string} type - Optional type: 'index' or 'stock'
   * @returns {Promise<Object>} - Underlying info with expiries
   */
  async getExpiries(underlying, type = null) {
    try {
      if (type && !['index', 'stock'].includes(type)) {
        throw new ValidationError('type must be either index or stock');
      }
      const normalizedUnderlying = underlying.toUpperCase();
      const brokerUnderlying = stripDerivativeSuffix(normalizedUnderlying);

      // Check if it's an index (from NSE_INDEX exchange)
      const indexCheck = type === 'stock' ? null : await db.get(`
        SELECT DISTINCT symbol as underlying, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        AND symbol = ?
        LIMIT 1
      `, [brokerUnderlying]);

      // Check if it's a stock/derivative (from BFO or NFO exchange) using underlying_key
      const stockCheck = type === 'index' ? null : await db.get(`
        SELECT DISTINCT underlying_key as underlying, 'stock' as type, exchange
        FROM instruments
        WHERE exchange IN ('BFO', 'NFO')
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        LIMIT 1
      `, [brokerUnderlying]);

      const underlyingCheck = indexCheck || stockCheck;

      if (!underlyingCheck) {
        throw new ValidationError(`Underlying ${underlying} not found or has no options`);
      }

      // Get all expiries for this underlying using underlying_key
      const expiries = await db.all(`
        SELECT DISTINCT expiry
        FROM instruments
        WHERE exchange IN ('NFO', 'BFO')
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        AND expiry IS NOT NULL
        ORDER BY expiry
      `, [brokerUnderlying]);

      return {
        underlying: brokerUnderlying,
        type: underlyingCheck.type,
        exchange: underlyingCheck.type === 'index' ? 'NFO' : 'BFO,NFO',
        expiries: expiries.map(row => row.expiry)
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get expiries', error, { underlying });
      throw error;
    }
  }

  /**
   * Get option chain for underlying + expiry
   * @param {string} underlying - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} type - Optional type: 'index' or 'stock'
   * @param {boolean} includeQuotes - Whether to include quotes
   * @param {number} strikeWindow - Optional window around ATM
   * @returns {Promise<Object>} - Option chain
   */
  async getOptionChain(underlying, expiry, type = null, includeQuotes = false, strikeWindow = null, forwardSource = 'carry') {
    try {
      const normalizedUnderlying = underlying.toUpperCase();
      // The expiry as asked for (what the response and cache carry), and as stored (ISO).
      const expiryKey = String(expiry || '').trim().toUpperCase();
      const isoExpiry = toISO(expiry) || expiryKey;

      const cached = this._getCached(normalizedUnderlying, expiryKey, includeQuotes, forwardSource);
      if (cached) return cached;

      const exchangeLookup = await db.get(
        `SELECT DISTINCT exchange FROM instruments WHERE underlying_key = ? LIMIT 1`,
        [normalizedUnderlying]
      );

      // Determine if it's an index or stock
      const indexCheck = await db.get(`
        SELECT symbol, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        AND symbol = ?
        LIMIT 1
      `, [normalizedUnderlying]);

      const isIndex = !!indexCheck;
      let exchangeDbList = isIndex || type === 'index' ? "'NFO'" : "'BFO','NFO'";
      let exchangeLabel = isIndex || type === 'index' ? 'NSE_INDEX' : 'NSE';
      if (exchangeLookup?.exchange && exchangeLookup.exchange.toUpperCase().includes('MCX')) {
        exchangeDbList = "'MCX'";
        exchangeLabel = 'MCX';
      }
      const brokerUnderlying = stripDerivativeSuffix(normalizedUnderlying);

      // The strike list always comes from instruments; the broker /optionchain only adds quotes
      // and Greeks, matched by symbol.
      const dbExchanges = exchangeDbList.replace(/'/g, '').split(',');
      let instrumentRows = [];
      for (const exch of dbExchanges) {
        const chain = await instrumentsService.buildOptionChain(normalizedUnderlying, isoExpiry, exch);
        instrumentRows = (chain?.strikes || []).filter((r) => r.strike > 0 && (r.ce || r.pe));
        if (instrumentRows.length) break;
      }

      if (!instrumentRows.length) {
        // Try to find available expiries to give a helpful error message
        const availableExpiries = await db.all(`
          SELECT DISTINCT expiry
          FROM instruments
          WHERE exchange IN (${exchangeDbList})
          AND instrumenttype IN ('CE', 'PE')
          AND underlying_key = ?
          AND expiry IS NOT NULL
          ORDER BY expiry
          LIMIT 5
        `, [normalizedUnderlying]);

        const expiryHint = availableExpiries.length > 0
          ? `. Available expiries: ${availableExpiries.map(e => e.expiry).join(', ')}`
          : '';

        throw new ValidationError(`No options found for ${underlying} with expiry ${expiry}${expiryHint}`);
      }

      let rows = instrumentRows.map((row) => ({
        strike: row.strike,
        ce: row.ce ? normalizeLeg({ symbol: row.ce.symbol, lotsize: row.ce.lotsize }) : null,
        pe: row.pe ? normalizeLeg({ symbol: row.pe.symbol, lotsize: row.pe.lotsize }) : null,
      }));

      const brokerChain = includeQuotes
        ? await this._getOptionChainFromBroker(brokerUnderlying, expiryKey, exchangeLabel, strikeWindow)
        : null;

      // Resolve spot from quotes (preferred), then the broker chain's underlying LTP / ATM
      const midStrike = rows[Math.floor(rows.length / 2)]?.strike ?? null;
      const brokerSpot = Number(brokerChain?.underlying_ltp || brokerChain?.atm_strike || 0) || null;
      const spotResolved = await resolveSpotQuote(
        normalizedUnderlying,
        exchangeLabel,
        brokerSpot ?? (includeQuotes ? null : midStrike)
      );

      // Restrict to window (default 17 ≈ 8 each side), centred on the strike nearest spot
      const windowSize = strikeWindow ? strikeWindow * 2 + 1 : 17;
      const atmStrike = nearestStrikeToSpot(rows, spotResolved) ?? midStrike;
      if (rows.length > windowSize) {
        const centerIndex = Math.max(0, rows.findIndex((r) => r.strike === atmStrike));
        const start = Math.max(0, centerIndex - Math.floor(windowSize / 2));
        rows = rows.slice(start, start + windowSize);
      }

      // The broker chain carries live quotes (and the Greeks computed from them) when
      // quotes_included is set; otherwise price the legs via multiquotes.
      // ponytail: legs outside the broker's strike window stay unpriced; widen strike_count if needed.
      let enriched;
      if (brokerChain?.quotes_included) {
        const brokerLegs = new Map();
        for (const item of brokerChain.chain) {
          for (const leg of [normalizeLeg(item.ce), normalizeLeg(item.pe)]) {
            if (leg?.symbol) brokerLegs.set(leg.symbol, leg);
          }
        }
        const overlay = (leg) => (leg && brokerLegs.has(leg.symbol)
          ? { ...brokerLegs.get(leg.symbol), lotsize: leg.lotsize ?? brokerLegs.get(leg.symbol).lotsize }
          : leg);
        enriched = rows.map((r) => ({ ...r, ce: overlay(r.ce), pe: overlay(r.pe) }));
      } else {
        enriched = await enrichWithQuotes(rows, exchangeLabel);
      }

      const atmResolved = nearestStrikeToSpot(enriched, spotResolved) || atmStrike;

      const metaBase = {
        underlying: normalizedUnderlying,
        expiry: expiryKey,
        exchange: exchangeLabel,
        atm_strike: atmResolved,
        spot: spotResolved || atmResolved || null,
        r: riskFreeRateForSymbol(normalizedUnderlying),
        q: dividendYieldForSymbol(normalizedUnderlying),
        T: parseExpiryToYearFraction(expiryKey) || 7 / 365,
      };
      const { rows: withGreeks, meta } = buildGreeksForRows(enriched, metaBase, forwardSource);
      const result = {
        underlying: normalizedUnderlying,
        type: isIndex ? 'index' : 'stock',
        exchange: exchangeLabel,
        expiry: expiryKey,
        has_quotes: includeQuotes,
        atm_strike: meta.atm_strike || atmStrike,
        rows: withGreeks,
        meta,
      };
      this._setCache(normalizedUnderlying, expiryKey, includeQuotes, result, forwardSource);
      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get option chain', error, { underlying, expiry });
      throw error;
    }
  }

  // One broker /optionchain fetch (first instance and exchange that answers); the raw chain or null.
  async _getOptionChainFromBroker(underlying, expiry, exchangeLabel, strikeWindow = null) {
    try {
      // Prefer instances flagged for option chain using health flags
      let pool = await marketDataInstanceService.getPoolForEndpoint('optionchain');
      if (!pool.length) return null;

      const orderedPool = pool.sort(
        (a, b) => Number(b.health_status === 'healthy') - Number(a.health_status === 'healthy')
      );
      const exchangeCandidates =
        exchangeLabel === 'MCX'
          ? ['MCX']
          : exchangeLabel === 'NSE_INDEX'
          ? ['NSE_INDEX', 'NFO', 'BFO']
          : ['NFO', 'BFO', exchangeLabel];
      let lastData = null;
      let brokerExpiry = null;

      for (const instance of orderedPool) {
        try {
          brokerExpiry = toBroker(expiry);
          let data = null;

          for (const exch of exchangeCandidates) {
            log.info('Option chain broker fetch attempt', {
              instance: instance.name || instance.id,
              exchange: exch,
              expiry: brokerExpiry,
              underlying,
            });
            // expiry_date is mandatory on /optionchain, so there is no expiry-less retry: it could
            // only come back 400. Greeks ride the same call (opengreeks Black-76, server-side).
            data = await openalgoClient.getOptionChain(
              instance,
              underlying,
              brokerExpiry,
              exch,
              {
                strikeCount: strikeWindow || 8, // limit to max 8 per side
                skipBackoff: true,
                greeksRate: riskFreeRateForSymbol(underlying) * 100,
              }
            );

            if (data && Array.isArray(data.chain) && data.chain.length) {
              // Stick with the exchange that worked
              break;
            }
          }

          if (!data || !Array.isArray(data.chain) || !data.chain.length) {
            continue;
          }

          lastData = data;
          log.info('Broker option chain fetched', {
            instance: instance.name || instance.id,
            exchange: data.exchange || exchangeLabel,
            expiry: data.expiry_date || brokerExpiry,
            strikes: data.chain.length,
          });
          break;
        } catch (err) {
          log.warn('Broker option chain attempt failed on instance', {
            instance: instance.name,
            error: err.message,
          });
          continue;
        }
      }

      return lastData;
    } catch (error) {
      log.warn('Broker option chain fetch failed', { underlying, error: error.message });
      return null;
    }
  }
}

export default new OptionChainService();
