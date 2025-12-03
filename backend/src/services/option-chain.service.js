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

// Math.erf is not available in all Node runtimes; provide a stable approximation
function erfApprox(x) {
  // Abramowitz and Stegun formula 7.1.26
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

function normCdf(x) {
  const erfFn = typeof Math.erf === 'function' ? Math.erf : erfApprox;
  return 0.5 * (1 + erfFn(x / Math.sqrt(2)));
}

function normPdf(x) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

function d1d2(F, K, T, sigma) {
  const volSqrtT = sigma * Math.sqrt(T);
  const lnFK = Math.log(F / K);
  const d1 = (lnFK + 0.5 * sigma * sigma * T) / volSqrtT;
  const d2 = d1 - volSqrtT;
  return { d1, d2 };
}

function black76Price(F, K, T, r, sigma, isCall) {
  const { d1, d2 } = d1d2(F, K, T, sigma);
  const disc = Math.exp(-r * T);
  return isCall
    ? disc * (F * normCdf(d1) - K * normCdf(d2))
    : disc * (K * normCdf(-d2) - F * normCdf(-d1));
}

function black76Greeks(F, K, T, r, sigma, isCall) {
  const { d1, d2 } = d1d2(F, K, T, sigma);
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);

  const delta = isCall ? disc * normCdf(d1) : -disc * normCdf(-d1);
  const gamma = disc * pdf / (F * sigma * Math.sqrt(T));
  const vega = disc * F * pdf * Math.sqrt(T);

  const theta =
    -disc * F * pdf * sigma / (2 * Math.sqrt(T)) +
    (isCall
      ? r * disc * (F * normCdf(d1) - K * normCdf(d2))
      : r * disc * (K * normCdf(-d2) - F * normCdf(-d1)));

  return {
    delta,
    gamma,
    vega,
    theta,
    thetaPerDay: theta / 365,
    d1,
    d2,
  };
}

function impliedVolBlack76(targetPrice, F, K, T, r, isCall, opts = {}) {
  const options = {
    tol: 1e-6,
    maxIter: 100,
    lower: 1e-4,
    upper: 3.0,
    ...opts,
  };

  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(F) || !Number.isFinite(K) || F <= 0 || K <= 0) {
    return 0;
  }

  let lo = options.lower;
  let hi = options.upper;
  let mid = (lo + hi) / 2;

  for (let i = 0; i < options.maxIter; i++) {
    mid = (lo + hi) / 2;
    const price = black76Price(F, K, T, r, mid, isCall);
    const diff = price - targetPrice;
    if (Math.abs(diff) < options.tol) break;
    if (diff > 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return mid;
}

function parseExpiryToYearFraction(expiry) {
  if (!expiry) return null;
  const now = new Date();
  let dt = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    dt = new Date(`${expiry}T15:30:00`);
  } else if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
    const [d, mon, yy] = expiry.split('-');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mi = monthNames.indexOf(mon);
    if (mi >= 0) dt = new Date(`20${yy}-${String(mi + 1).padStart(2, '0')}-${d}T15:30:00`);
  } else if (/^\d{2}[A-Z]{3}\d{2}$/.test(expiry)) {
    const d = expiry.slice(0, 2);
    const mon = expiry.slice(2, 5);
    const yy = expiry.slice(5, 7);
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mi = monthNames.indexOf(mon);
    if (mi >= 0) dt = new Date(`20${yy}-${String(mi + 1).padStart(2, '0')}-${d}T15:30:00`);
  }
  if (!dt) return null;
  const ms = dt.getTime() - now.getTime();
  const years = ms / (1000 * 60 * 60 * 24 * 365.25);
  return years > 0 ? years : null;
}

function riskFreeRateForSymbol(sym) {
  if (!sym) return 0.0675;
  const u = sym.toUpperCase();
  if (u.includes('NIFTY')) return 0.0675;
  if (u.includes('BANKNIFTY')) return 0.0675;
  return 0.0675;
}

function dividendYieldForSymbol(sym) {
  if (!sym) return 0.012;
  const u = sym.toUpperCase();
  if (u.includes('NIFTY')) return 0.014;
  if (u.includes('BANKNIFTY')) return 0.011;
  return 0.01;
}

function normalizeLeg(raw) {
  if (!raw) return null;
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return null;
  };
  return {
    symbol: raw.symbol || raw.tradingsymbol || '',
    ltp: pick(raw, ['ltp', 'last_price', 'trade_price', 'last', 'price', 'close']),
    bid: pick(raw, ['bid', 'bid_price', 'best_bid_price', 'bidPrice']),
    ask: pick(raw, ['ask', 'ask_price', 'best_ask_price', 'askPrice']),
    volume: pick(raw, ['volume', 'vol', 'traded_volume', 'volumeTraded', 'qty_traded']),
    oi: pick(raw, ['oi', 'open_interest', 'openInterest']),
    lotsize: pick(raw, ['lotsize', 'lot_size', 'lotSize']),
  };
}

async function enrichWithQuotes(rows, exchangeLabel) {
  try {
    const quoteExchange = exchangeLabel === 'NSE_INDEX' ? 'NFO' : exchangeLabel;
    const pool = await marketDataInstanceService.getPoolForEndpoint('multiquotes');
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

function fillMissingLtp(leg) {
  if (!leg) return leg;
  const hasLtp = Number(leg.ltp || 0) > 0;
  if (!hasLtp) {
    const bid = Number(leg.bid || 0);
    const ask = Number(leg.ask || 0);
    if (bid > 0 && ask > 0) {
      leg.ltp = (bid + ask) / 2;
    } else if (bid > 0) {
      leg.ltp = bid;
    } else if (ask > 0) {
      leg.ltp = ask;
    }
  }
  return leg;
}

function findNearestAtmRow(rows, atmStrike) {
  if (!rows?.length) return null;
  if (!atmStrike) return rows[Math.floor(rows.length / 2)];
  let best = rows[0];
  let bestDiff = Math.abs(rows[0].strike - atmStrike);
  for (const r of rows) {
    const diff = Math.abs(r.strike - atmStrike);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

function computeForwardSet({ spot, atmRow, T, r, q }) {
  const F_carry = Number.isFinite(spot) && spot > 0 ? spot * Math.exp((r - q) * T) : null;
  let F_synth_exact = null;
  let F_synth_simple = null;
  if (atmRow?.strike && atmRow?.ce && atmRow?.pe) {
    const C = Number(atmRow.ce.ltp || 0);
    const P = Number(atmRow.pe.ltp || 0);
    const K = Number(atmRow.strike);
    if (C > 0 || P > 0) {
      F_synth_exact = K + Math.exp(r * T) * (C - P);
      F_synth_simple = K + (C - P);
    }
  }
  return { F_carry, F_synth_exact, F_synth_simple };
}

function chooseForward(forwardSource, forwards) {
  const order = ['carry', 'synth_exact', 'synth_simple'];
  const requested = forwardSource && order.includes(forwardSource) ? forwardSource : 'carry';
  const value =
    (requested === 'carry' && forwards.F_carry) ||
    (requested === 'synth_exact' && forwards.F_synth_exact) ||
    (requested === 'synth_simple' && forwards.F_synth_simple);
  if (value) return { forwardUsed: requested, forwardValue: value };
  // fallback to first available
  for (const key of order) {
    if (forwards[`F_${key}`]) return { forwardUsed: key, forwardValue: forwards[`F_${key}`] };
  }
  return { forwardUsed: requested, forwardValue: null };
}

function buildGreeksForRows(rows, meta, forwardSource = 'carry') {
  const round3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);
  const { r, q, T, spot } = meta;
  const forwards = computeForwardSet({
    spot,
    atmRow: findNearestAtmRow(rows, meta.atm_strike || meta.atmStrike),
    T,
    r,
    q,
  });
  const atmRow = findNearestAtmRow(rows, meta.atm_strike || meta.atmStrike);
  const atmStrikeResolved = atmRow?.strike || meta.atm_strike || meta.atmStrike || null;
  const { forwardUsed, forwardValue } = chooseForward(forwardSource, forwards);
  const forwardFallback = forwardValue || atmStrikeResolved || spot || rows[0]?.strike || 1;

  const processedRows = rows.map((row) => {
    const K = Number(row.strike || 0);
    const processLeg = (leg, isCall) => {
      if (!leg) return null;
      const enrichedLeg = fillMissingLtp({ ...leg });
      const ltpNum = Number(enrichedLeg.ltp || 0);
      let iv = null;
      let greeks = null;
      if (ltpNum > 0 && K > 0 && T > 0 && forwardFallback > 0) {
        iv = impliedVolBlack76(ltpNum, forwardFallback, K, T, r, isCall);
        const g = black76Greeks(forwardFallback, K, T, r, iv || 0.0001, isCall);
        greeks = {
          delta: round3(g.delta),
          gamma: round3(g.gamma),
          theta: round3(g.thetaPerDay),
          vega: round3(g.vega),
        };
      }
      return {
        ...enrichedLeg,
        iv: iv !== null ? round3(iv) : null,
        greeks,
      };
    };
    return {
      ...row,
      ce: processLeg(row.ce, true),
      pe: processLeg(row.pe, false),
    };
  });

  const callOi = processedRows.reduce((sum, r) => sum + (Number(r.ce?.oi || 0)), 0);
  const putOi = processedRows.reduce((sum, r) => sum + (Number(r.pe?.oi || 0)), 0);

  return {
    rows: processedRows,
    meta: {
      ...meta,
      ...forwards,
      forward_used: forwardUsed,
      forward_value: forwardFallback,
      atm_strike: atmStrikeResolved,
      call_oi_total: callOi,
      put_oi_total: putOi,
    },
  };
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

function nearestStrikeToSpot(rows, spot) {
  if (!rows?.length || !Number.isFinite(spot) || spot <= 0) return null;
  let best = rows[0].strike;
  let bestDiff = Math.abs(rows[0].strike - spot);
  for (const r of rows) {
    const diff = Math.abs(r.strike - spot);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r.strike;
    }
  }
  return best;
}

function stripDerivativeSuffix(sym) {
  if (!sym) return sym;
  const upper = sym.toUpperCase();
  // Remove common derivative tails like 26DEC25FUT, 30DEC25CE, 30DEC25PE
  const m = upper.match(/^(.*?)(\d{2}[A-Z]{3}\d{2}(FUT|CE|PE))$/);
  if (m && m[1]) return m[1];
  return upper;
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
   * Get all underlyings that have options
   * @param {string} type - Optional filter: 'index' or 'stock'
   * @returns {Promise<Object>} - List of indices and stocks
   */
  async getUnderlyings(type = null) {
    try {
      // Get index underlyings from NSE_INDEX exchange
      const indices = await db.all(`
        SELECT DISTINCT symbol as name, symbol, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        ORDER BY symbol
      `);

      // Get stock underlyings from both BFO and NFO exchanges using underlying_key
      const stocks = await db.all(`
        SELECT DISTINCT underlying_key as name, underlying_key as symbol, 'stock' as type
        FROM instruments
        WHERE exchange IN ('BFO', 'NFO')
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key IS NOT NULL
        AND underlying_key NOT IN (
          SELECT symbol FROM instruments WHERE exchange = 'NSE_INDEX' AND instrumenttype = 'INDEX'
        )
        ORDER BY underlying_key
      `);

      return {
        indices,
        stocks
      };
    } catch (error) {
      log.error('Failed to get underlyings', error);
      throw error;
    }
  }

  /**
   * Get available expiries for an underlying
   * @param {string} underlying - Underlying symbol
   * @param {string} type - Optional type: 'index' or 'stock'
   * @returns {Promise<Object>} - Underlying info with expiries
   */
  async getExpiries(underlying, type = null) {
    try {
      const normalizedUnderlying = underlying.toUpperCase();
      const brokerUnderlying = stripDerivativeSuffix(normalizedUnderlying);

      // Check if it's an index (from NSE_INDEX exchange)
      const indexCheck = await db.get(`
        SELECT DISTINCT symbol as underlying, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        AND symbol = ?
        LIMIT 1
      `, [normalizedUnderlying]);

      // Check if it's a stock/derivative (from BFO or NFO exchange) using underlying_key
      const stockCheck = await db.get(`
        SELECT DISTINCT underlying_key as underlying, 'stock' as type, exchange
        FROM instruments
        WHERE exchange IN ('BFO', 'NFO')
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        LIMIT 1
      `, [normalizedUnderlying]);

      const underlyingCheck = indexCheck || stockCheck;

      if (!underlyingCheck) {
        throw new ValidationError(`Underlying ${underlying} not found or has no options`);
      }

      const exchange = underlyingCheck.exchange || (underlyingCheck.type === 'index' ? 'NSE_INDEX' : 'BFO');

      // Get all expiries for this underlying using underlying_key
      const expiries = await db.all(`
        SELECT DISTINCT expiry
        FROM instruments
        WHERE exchange IN ('NFO', 'BFO')
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        AND expiry IS NOT NULL
        ORDER BY expiry
      `, [normalizedUnderlying]);

      return {
        underlying: normalizedUnderlying,
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
      const expiryVariants = this._expandExpiryFormats(expiry);

      const cached = this._getCached(normalizedUnderlying, expiryVariants[0], includeQuotes, forwardSource);
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

      // Try broker option chain first when quotes requested and a supporting instance exists
      if (includeQuotes) {
        const liveChain = await this._getOptionChainFromBroker(
          brokerUnderlying,
          expiryVariants,
          exchangeLabel,
          strikeWindow,
          forwardSource
        );
        if (liveChain && liveChain.rows?.length) {
          log.info('Option chain (broker)', {
            underlying: normalizedUnderlying,
            expiry: liveChain.expiry,
            rows: liveChain.rows.length,
            source: 'broker',
          });
          this._setCache(normalizedUnderlying, expiryVariants[0], includeQuotes, liveChain, forwardSource);
          return liveChain;
        }
        log.warn('Broker option chain returned empty, falling back to DB cache', {
          underlying: normalizedUnderlying,
          expiry: expiryVariants[0],
        });
      }

      // Validate underlying and expiry using underlying_key
      const placeholders = expiryVariants.map(() => '?').join(', ');
      const expiryCheck = await db.get(`
        SELECT DISTINCT expiry
        FROM instruments
        WHERE exchange IN (${exchangeDbList})
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        AND expiry IN (${placeholders})
        LIMIT 1
      `, [normalizedUnderlying, ...expiryVariants]);

      if (!expiryCheck) {
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

      // Get all CE and PE for this underlying + expiry using underlying_key
      const options = await db.all(`
        SELECT symbol, underlying_key, strike, lotsize, instrumenttype, exchange
        FROM instruments
        WHERE exchange IN (${exchangeDbList})
        AND instrumenttype IN ('CE', 'PE')
        AND underlying_key = ?
        AND expiry IN (${placeholders})
        AND strike > 0
        ORDER BY strike
      `, [normalizedUnderlying, ...expiryVariants]);

      // Pivot into chain rows
      const strikesMap = new Map();

      for (const option of options) {
        const strike = option.strike;
        if (!strikesMap.has(strike)) {
          strikesMap.set(strike, {
            strike: strike,
            call_symbol: null,
            call_lotsize: null,
            put_symbol: null,
            put_lotsize: null
          });
        }

        const row = strikesMap.get(strike);
        if (option.instrumenttype === 'CE') {
          row.call_symbol = option.symbol;
          row.call_lotsize = option.lotsize;
        } else if (option.instrumenttype === 'PE') {
          row.put_symbol = option.symbol;
          row.put_lotsize = option.lotsize;
        }
      }

      // Convert to array and sort by strike
      let rows = Array.from(strikesMap.values()).sort((a, b) => a.strike - b.strike);

      // Approximate ATM (may be refined later with quotes/spot)
      let atmStrike = rows.length ? rows[Math.floor(rows.length / 2)]?.strike : null;

      // Attach symbol placeholders for UI
      rows = rows.map((row) => {
        const ceNorm = row.call_symbol ? normalizeLeg({ symbol: row.call_symbol, lotsize: row.call_lotsize }) : null;
        const peNorm = row.put_symbol ? normalizeLeg({ symbol: row.put_symbol, lotsize: row.put_lotsize }) : null;
        return {
          strike: row.strike,
          ce: ceNorm || null,
          pe: peNorm || null,
        };
      });

      // Restrict to window (default 17 ≈ 8 each side)
      const windowSize = strikeWindow ? strikeWindow * 2 + 1 : 17;
      if (rows.length > windowSize) {
        const centerIndex = atmStrike
          ? Math.max(0, rows.findIndex((r) => r.strike === atmStrike))
          : Math.floor(rows.length / 2);
        const start = Math.max(0, centerIndex - Math.floor(windowSize / 2));
        rows = rows.slice(start, start + windowSize);
      }

      const enriched = await enrichWithQuotes(rows, exchangeLabel);

      // Resolve spot from quotes (preferred), then broker LTP/ATM
      const spotResolved = await resolveSpotQuote(
        normalizedUnderlying,
        exchangeLabel,
        includeQuotes ? null : atmStrike
      );
      const atmResolved = nearestStrikeToSpot(enriched, spotResolved) || atmStrike;

      const metaBase = {
        underlying: normalizedUnderlying,
        expiry: expiryVariants[0],
        exchange: exchangeLabel,
        atm_strike: atmResolved,
        spot: spotResolved || atmResolved || null,
        r: riskFreeRateForSymbol(normalizedUnderlying),
        q: dividendYieldForSymbol(normalizedUnderlying),
        T: parseExpiryToYearFraction(expiryVariants[0]) || 7 / 365,
      };
      const { rows: withGreeks, meta } = buildGreeksForRows(enriched, metaBase, forwardSource);
      const result = {
        underlying: normalizedUnderlying,
        type: isIndex ? 'index' : 'stock',
        exchange: exchangeLabel,
        expiry: expiryVariants[0],
        has_quotes: includeQuotes,
        atm_strike: meta.atm_strike || atmStrike,
        rows: withGreeks,
        meta,
      };
      this._setCache(normalizedUnderlying, expiryVariants[0], includeQuotes, result, forwardSource);
      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get option chain', error, { underlying, expiry });
      throw error;
    }
  }

  /**
   * Build a sample option chain for testing
   * @param {string} underlying - Underlying symbol
   * @returns {Promise<Object>} - Sample chain with sample data
   */
  async getSampleChain(underlying) {
    try {
      // First get available expiries
      const expiriesResult = await this.getExpiries(underlying);
      const firstExpiry = expiriesResult.expiries[0];

      if (!firstExpiry) {
        throw new ValidationError(`No expiries found for ${underlying}`);
      }

      const chain = await this.getOptionChain(underlying, firstExpiry, null, false, null);

      // Add sample quotes for demonstration
      chain.rows = chain.rows.map(row => {
        const sampleRow = { ...row };

        if (row.call_symbol) {
          sampleRow.call_quote = {
            ltp: Math.random() * 100,
            bid_price: Math.random() * 100,
            bid_qty: Math.floor(Math.random() * 500),
            ask_price: Math.random() * 100,
            ask_qty: Math.floor(Math.random() * 500),
            oi: Math.floor(Math.random() * 200000),
            volume: Math.floor(Math.random() * 5000),
            iv: 10 + Math.random() * 10
          };
        }

        if (row.put_symbol) {
          sampleRow.put_quote = {
            ltp: Math.random() * 100,
            bid_price: Math.random() * 100,
            bid_qty: Math.floor(Math.random() * 500),
            ask_price: Math.random() * 100,
            ask_qty: Math.floor(Math.random() * 500),
            oi: Math.floor(Math.random() * 200000),
            volume: Math.floor(Math.random() * 5000),
            iv: 10 + Math.random() * 10
          };
        }

        return sampleRow;
      });

      chain.has_quotes = true;
      chain.spot = 24000 + Math.random() * 1000;
      chain.atm_strike = chain.rows[Math.floor(chain.rows.length / 2)]?.strike || 0;
      chain.strike_window = 5;

      return chain;
    } catch (error) {
      log.error('Failed to get sample chain', error, { underlying });
      throw error;
    }
  }

  /**
   * Expand expiry formats to support DB (DD-MMM-YY) and ISO (YYYY-MM-DD) and broker (DDMMMYY)
   * @param {string} expiry
   * @returns {string[]} unique variants
   */
  _expandExpiryFormats(expiry) {
    if (!expiry) return [];
    const variants = new Set();
    const upper = String(expiry).toUpperCase().trim();
    variants.add(upper);

    // YYYY-MM-DD -> DD-MMM-YY and DDMMMYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(upper)) {
      const d = new Date(upper);
      const day = String(d.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const mon = monthNames[d.getMonth()];
      const yy = String(d.getFullYear()).slice(-2);
      variants.add(`${day}-${mon}-${yy}`);
      variants.add(`${day}${mon}${yy}`);
    }

    // DD-MMM-YY -> YYYY-MM-DD and DDMMMYY
    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(upper)) {
      const [day, mon, yy] = upper.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const idx = monthNames.indexOf(mon);
      if (idx >= 0) {
        const yyyy = `20${yy}`;
        const month = String(idx + 1).padStart(2, '0');
        variants.add(`${yyyy}-${month}-${day}`);
        variants.add(`${day}${mon}${yy}`);
      }
    }

    // DDMMMYY -> add hyphenated and ISO
    if (/^\d{2}[A-Z]{3}\d{2}$/.test(upper)) {
      const day = upper.slice(0, 2);
      const mon = upper.slice(2, 5);
      const yy = upper.slice(5, 7);
      variants.add(`${day}-${mon}-${yy}`);
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const idx = monthNames.indexOf(mon);
      if (idx >= 0) {
        const yyyy = `20${yy}`;
        const month = String(idx + 1).padStart(2, '0');
        variants.add(`${yyyy}-${month}-${day}`);
      }
    }

    return Array.from(variants);
  }

  async _getOptionChainFromBroker(underlying, expiryVariants, exchangeLabel, strikeWindow = null, forwardSource = 'carry') {
    try {
      // Prefer instances flagged for option chain using health flags
      let pool = await marketDataInstanceService.getPoolForEndpoint('optionchain');
      if (!pool.length) return null;

      const orderedPool = pool.sort((a, b) => (a.health_status === 'healthy' ? -1 : 1));
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
          brokerExpiry = expiryVariants.find((e) => /^\d{2}[A-Z]{3}\d{2}$/.test(e)) || expiryVariants[0];
          let data = null;

          for (const exch of exchangeCandidates) {
            log.info('Option chain broker fetch attempt', {
              instance: instance.name || instance.id,
              exchange: exch,
              expiry: brokerExpiry,
              underlying,
            });
            // First try with the requested expiry
            data = await openalgoClient.getOptionChain(
              instance,
              underlying,
              brokerExpiry,
              exch,
              {
                strikeCount: strikeWindow || 8, // limit to max 8 per side
                skipBackoff: true,
              }
            );

            // Retry without expiry to let broker return nearest/next if none for requested
            if (!data || !Array.isArray(data.chain) || !data.chain.length) {
              data = await openalgoClient.getOptionChain(
                instance,
              underlying,
              null,
              exch,
              {
                strikeCount: strikeWindow || 8,
                skipBackoff: true,
              }
            );
            }

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

      if (!lastData || !Array.isArray(lastData.chain) || !lastData.chain.length) return null;

      // Center around ATM when available
      let chainRows = lastData.chain;
      const windowSize = strikeWindow ? strikeWindow * 2 + 1 : 17;
      if (lastData.atm_strike && chainRows.length > windowSize) {
        const atmIndex = chainRows.findIndex((c) => Number(c.strike) === Number(lastData.atm_strike));
        const center = atmIndex >= 0 ? atmIndex : Math.floor(chainRows.length / 2);
        const start = Math.max(0, center - Math.floor(windowSize / 2));
        chainRows = chainRows.slice(start, start + windowSize);
      } else {
        chainRows = chainRows.slice(0, windowSize);
      }

      const rows = chainRows
        .map((item) => {
          const ceNorm = normalizeLeg(item.ce);
          const peNorm = normalizeLeg(item.pe);
          return {
            strike: item.strike,
            ce: ceNorm || null,
            pe: peNorm || null,
          };
        })
        .sort((a, b) => a.strike - b.strike);

      const enriched = await enrichWithQuotes(rows, exchangeLabel);

      const spotResolved = await resolveSpotQuote(
        underlying,
        exchangeLabel,
        Number(lastData.underlying_ltp || lastData.atm_strike || 0) || null
      );
      const atmResolved = nearestStrikeToSpot(enriched, spotResolved) || lastData.atm_strike || null;

      const metaBase = {
        underlying,
        expiry: lastData.expiry_date || brokerExpiry,
        exchange: exchangeLabel,
        atm_strike: atmResolved,
        spot: spotResolved || atmResolved || null,
        r: riskFreeRateForSymbol(underlying),
        q: dividendYieldForSymbol(underlying),
        T: parseExpiryToYearFraction(lastData.expiry_date || brokerExpiry) || 7 / 365,
      };
      const { rows: withGreeks, meta } = buildGreeksForRows(enriched, metaBase, forwardSource);

      return {
        underlying,
        type: exchangeLabel === 'NSE_INDEX' ? 'index' : 'stock',
        exchange: exchangeLabel,
        expiry: meta.expiry,
        has_quotes: true,
        atm_strike: meta.atm_strike || lastData.atm_strike || null,
        rows: withGreeks,
        meta,
      };
    } catch (error) {
      log.warn('Broker option chain fetch failed', { underlying, error: error.message });
      return null;
    }
  }
}

export default new OptionChainService();
export { OptionChainService };
