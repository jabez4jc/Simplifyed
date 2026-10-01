/**
 * Exit levels on the underlying, and the rupee max-loss backstop.
 *
 * A level is a price on the CHARTED instrument - an index, a future, an equity, an MCX future.
 * When that instrument's price reaches it, the app exits the positions it covers, on every account
 * it applies to:
 *
 *   - the underlying itself (the charted row, futures of every expiry, the cash equity) and its
 *     options (every expiry);
 *   - by direction: below the price a level stops out BULLISH positions (long underlying, long CE,
 *     short PE) and takes profit on BEARISH ones - above the price, the reverse. `coverage` narrows
 *     it to one direction;
 *   - worked out when it TRIGGERS, from each account's live position book, so positions opened
 *     after the level was placed are covered and closed ones drop out.
 *
 * It fires once, after the crossing has held for the confirmation window, only while the exchange
 * is open and only on a fresh price (a stale feed blocks it and says so). A full-size level cancels
 * the opposite level on the same instrument. Exits go through the same close path as every other
 * exit: LIMIT on Indian exchanges, in the position's own product.
 *
 * The rupee max-loss backstop lives in exit-loss-caps.service.js and reuses the lookups here.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { config } from '../core/config.js';
import marketDataFeedService from './market-data-feed.service.js';
import marketCalendarService from './market-calendar.service.js';
import derivativeResolutionService from './derivative-resolution.service.js';
import quickOrderService from './quick-order.service.js';
import { resolveOptionsUnderlyingKey, isContractExpired, contractExpiry } from '../utils/underlying.util.js';
import {
  positionDirection, roleFor, covers, trailCoverage, hasCrossed, trail, exitQuantity,
} from '../utils/exit-levels.util.js';
import {
  black76Price, impliedVolBlack76, parseExpiryToYearFraction, riskFreeRateForSymbol,
} from '../utils/black76-pricing.util.js';

const FRESH_MS = 15000;          // a reference price older than this does not trigger anything
const CONFIRM_MS = 2000;         // a crossing must hold this long (one bad tick is not a trigger)
const OPEN_CACHE_MS = 60000;
const STALE_WARN_MS = 5 * 60000;
const SIDES = ['BELOW', 'ABOVE'];
const COVERAGES = ['ALL', 'BULLISH', 'BEARISH'];
const SIZE_MODES = ['FULL', 'PERCENT', 'LOTS'];

const qtyOf = (p) => Number(p?.quantity ?? p?.netqty ?? p?.net_quantity ?? p?.netQty ?? 0) || 0;
const upper = (v) => String(v || '').trim().toUpperCase();

class ExitLevelsService {
  constructor() {
    this.crossSince = new Map();   // level id / cap key -> first time seen crossed
    this.staleWarnedAt = new Map();
    this.openCache = new Map();
    this.evaluating = false;
  }

  // ---------------------------------------------------------------- lookups

  async _row(symbolId) {
    const row = await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [symbolId]);
    if (!row) throw new NotFoundError('Symbol');
    return row;
  }

  /** Active accounts on the level's watchlist, narrowed to its own list when it has one. */
  async _instances(watchlistId, instanceIdsJson = null) {
    const all = await db.all(
      `SELECT i.* FROM instances i JOIN watchlist_instances wi ON wi.instance_id = i.id
        WHERE wi.watchlist_id = ? AND i.is_active = 1 ORDER BY i.name`,
      [watchlistId]
    );
    let only = null;
    try { only = instanceIdsJson ? JSON.parse(instanceIdsJson) : null; } catch (_) { only = null; }
    return Array.isArray(only) ? all.filter((i) => only.includes(i.id)) : all;
  }

  /** What "this underlying" means for a charted row. */
  async _keys(row) {
    return {
      exchange: upper(row.exchange),
      symbol: upper(row.symbol),
      rowType: row.symbol_type === 'FUTURES' || row.instrumenttype === 'FUT' ? 'FUT' : 'UNDERLYING',
      rowLot: Number(row.lot_size) || 1,
      optionsKey: upper(await resolveOptionsUnderlyingKey(row)),
      futKey: upper(derivativeResolutionService.getDerivativeUnderlying(row)),
    };
  }

  /**
   * Is this position on the underlying? Returns its type ('CE' | 'PE' | 'FUT' | 'UNDERLYING') and
   * lot size, or null. `cache` memoises instrument lookups for one pass.
   */
  async _classify(position, keys, cache) {
    const exchange = upper(position.exchange || position.exch);
    const symbol = upper(position.symbol || position.tradingsymbol).replace(/\s+/g, '');
    if (!exchange || !symbol) return null;
    if (exchange === keys.exchange && symbol === keys.symbol) return { type: keys.rowType, lot: keys.rowLot };
    const k = `${exchange}|${symbol}`;
    if (!cache.has(k)) {
      cache.set(k, await db.get(
        'SELECT instrumenttype, underlying_key, lotsize, expiry FROM instruments WHERE UPPER(exchange) = ? AND UPPER(symbol) = ? LIMIT 1',
        [exchange, symbol]
      ).catch(() => null));
    }
    const inst = cache.get(k);
    if (!inst) return null;
    const type = upper(inst.instrumenttype);
    const key = upper(inst.underlying_key);
    if ((type === 'CE' || type === 'PE') && keys.optionsKey && key === keys.optionsKey) return { type, lot: inst.lotsize || 1 };
    if (type === 'FUT' && keys.futKey && key === keys.futKey) return { type: 'FUT', lot: inst.lotsize || 1 };
    if ((exchange === 'NSE' || exchange === 'BSE') && !['FUT', 'CE', 'PE'].includes(type) && symbol === keys.futKey) {
      return { type: 'UNDERLYING', lot: 1 };
    }
    return null;
  }

  /** The positions a level acts on, from a Map(instanceId -> positions[]). */
  async _covered(level, keys, instances, booksByInstance) {
    const coverage = level.kind === 'TRAIL' ? trailCoverage(level.side) : level.coverage;
    const cache = new Map();
    const out = [];
    for (const inst of instances) {
      for (const p of booksByInstance.get(inst.id) || []) {
        const qty = qtyOf(p);
        if (!qty) continue;
        const cls = await this._classify(p, keys, cache);
        if (!cls) continue;
        const direction = positionDirection(cls.type, qty);
        if (!covers(coverage, direction)) continue;
        out.push({ instance: inst, position: p, qty, ...cls, direction, role: roleFor(level.side, direction) });
      }
    }
    return out;
  }

  _cachedBooks(instances) {
    const map = new Map();
    for (const inst of instances) {
      const snap = marketDataFeedService.getPositionSnapshot(inst.id);
      map.set(inst.id, Array.isArray(snap?.data) ? snap.data : []);
    }
    return map;
  }

  /** The charted instrument's price, only if fresh. */
  _freshPrice(exchange, symbol) {
    const { cached } = marketDataFeedService.getCachedQuoteEntriesForSymbols([{ exchange, symbol }], { ttlMs: FRESH_MS });
    const ltp = Number(cached[0]?.quote?.ltp);
    return ltp > 0 ? ltp : null;
  }

  async _currentPrice(exchange, symbol) {
    const fresh = this._freshPrice(exchange, symbol);
    if (fresh) return fresh;
    marketDataFeedService.ensureSymbolSubscribed(exchange, symbol);
    const res = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, { maxRounds: 1 }).catch(() => null);
    const ltp = Number(res?.ltp ?? res?.quote?.ltp);
    return ltp > 0 ? ltp : null;
  }

  async _isOpen(exchange) {
    const hit = this.openCache.get(exchange);
    if (hit && Date.now() - hit.at < OPEN_CACHE_MS) return hit.open;
    // If the calendar cannot say (null/throw), evaluate anyway: a FRESH price is the evidence the
    // market is trading, and a calendar outage must not switch every stop off.
    const open = (await marketCalendarService.isExchangeOpen(exchange).catch(() => null)) !== false;
    this.openCache.set(exchange, { open, at: Date.now() });
    return open;
  }

  // ---------------------------------------------------------------- description

  /** "SL for 2 bullish · target for 1 bearish · 2 accounts · full" - from the cached books. */
  async describe(level, row = null) {
    const r = row || await this._row(level.symbol_id);
    const keys = await this._keys(r);
    const instances = await this._instances(level.watchlist_id, level.instance_ids);
    const covered = await this._covered(level, keys, instances, this._cachedBooks(instances));
    const count = (dir) => covered.filter((c) => c.direction === dir).length;
    const bull = count('BULLISH');
    const bear = count('BEARISH');
    const part = (dir, n) => `${roleFor(level.side, dir) === 'STOP' ? 'SL' : 'target'} for ${n} ${dir.toLowerCase()}`;
    const coverage = level.kind === 'TRAIL' ? trailCoverage(level.side) : level.coverage;
    const roles = [];
    if (covers(coverage, 'BULLISH')) roles.push(part('BULLISH', bull));
    if (covers(coverage, 'BEARISH')) roles.push(part('BEARISH', bear));
    const accounts = new Set(covered.map((c) => c.instance.id)).size;
    const size = level.size_mode === 'PERCENT' ? `${level.size_value}%`
      : level.size_mode === 'LOTS' ? `${level.size_value} lot${Number(level.size_value) === 1 ? '' : 's'}` : 'full';
    const head = level.kind === 'TRAIL' ? `Trailing SL (${level.trail_distance} pts)` : `Level ${level.trigger_price}`;
    return {
      label: `${head} → ${roles.join(' · ')} · ${accounts || instances.length} account${(accounts || instances.length) === 1 ? '' : 's'} · ${size}`,
      bullish: bull,
      bearish: bear,
      mixed: bull > 0 && bear > 0,
      accounts: instances.map((i) => ({ id: i.id, name: i.name, isAnalyzer: Boolean(i.is_analyzer_mode) })),
    };
  }

  /** What a level at `price` would do right now - drives the placement dialog. */
  async preview(symbolId, price) {
    const row = await this._row(symbolId);
    const ltp = await this._currentPrice(row.exchange, row.symbol);
    if (!ltp) throw new ValidationError(`No current price for ${row.symbol} - cannot place a level`);
    const side = Number(price) < ltp ? 'BELOW' : 'ABOVE';
    const draft = { watchlist_id: row.watchlist_id, symbol_id: row.id, side, kind: 'LEVEL', coverage: 'ALL', size_mode: 'FULL', trigger_price: Number(price) };
    return { ltp, side, ...(await this.describe(draft, row)) };
  }

  // ---------------------------------------------------------------- writes

  _validateSize(sizeMode, sizeValue) {
    const mode = upper(sizeMode || 'FULL');
    if (!SIZE_MODES.includes(mode)) throw new ValidationError(`size_mode must be one of ${SIZE_MODES.join(', ')}`);
    if (mode === 'PERCENT') {
      const v = Number(sizeValue);
      if (!(v > 0 && v <= 100)) throw new ValidationError('size_value must be a percentage from 1 to 100');
      return { mode, value: v };
    }
    if (mode === 'LOTS') {
      const v = Number(sizeValue);
      if (!Number.isInteger(v) || v < 1) throw new ValidationError('size_value must be a whole number of lots (1 or more)');
      return { mode, value: v };
    }
    return { mode, value: null };
  }

  async _validInstanceIds(watchlistId, ids) {
    if (ids === undefined || ids === null) return null;
    if (!Array.isArray(ids) || !ids.length) throw new ValidationError('instanceIds must be a non-empty list, or omitted for every account');
    const allowed = new Set((await this._instances(watchlistId)).map((i) => i.id));
    const clean = [...new Set(ids.map(Number))];
    if (clean.some((id) => !allowed.has(id))) throw new ValidationError('instanceIds must be accounts on this watchlist');
    return JSON.stringify(clean);
  }

  async create({ symbolId, price, coverage = 'ALL', sizeMode = 'FULL', sizeValue = null, instanceIds = null, trailing = false, userId = null }) {
    const row = await this._row(symbolId);
    const at = Number(price);
    if (!(at > 0)) throw new ValidationError('price must be a positive number');
    const ltp = await this._currentPrice(row.exchange, row.symbol);
    if (!ltp) throw new ValidationError(`No current price for ${row.symbol} - cannot place a level`);
    if (at === ltp) throw new ValidationError('A level cannot sit exactly at the current price');
    const side = at < ltp ? 'BELOW' : 'ABOVE';
    const cov = upper(coverage || 'ALL');
    if (!COVERAGES.includes(cov)) throw new ValidationError(`coverage must be one of ${COVERAGES.join(', ')}`);
    const size = this._validateSize(sizeMode, sizeValue);
    const ids = await this._validInstanceIds(row.watchlist_id, instanceIds);
    const kind = trailing ? 'TRAIL' : 'LEVEL';

    const { lastID } = await db.run(
      `INSERT INTO exit_levels (watchlist_id, symbol_id, ref_exchange, ref_symbol, kind, side, trigger_price,
         trail_distance, best_price, coverage, size_mode, size_value, instance_ids, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.watchlist_id, row.id, upper(row.exchange), upper(row.symbol), kind, side, at,
        trailing ? Math.abs(ltp - at) : null, trailing ? ltp : null,
        trailing ? trailCoverage(side) : cov, size.mode, size.value, ids, userId]
    );
    log.info('Exit level placed', { symbol: row.symbol, exchange: row.exchange, reason: `${kind} ${side} ${at}` });
    return this.get(lastID);
  }

  async get(id) {
    const level = await db.get('SELECT * FROM exit_levels WHERE id = ?', [id]);
    if (!level) throw new NotFoundError('Exit level');
    return { ...level, ...(await this.describe(level)) };
  }

  /** Drag: move the price, but never across the market - that would flip what the level means. */
  async move(id, price) {
    const level = await db.get("SELECT * FROM exit_levels WHERE id = ? AND status = 'ACTIVE'", [id]);
    if (!level) throw new NotFoundError('Active exit level');
    const at = Number(price);
    if (!(at > 0)) throw new ValidationError('price must be a positive number');
    const ltp = await this._currentPrice(level.ref_exchange, level.ref_symbol);
    if (ltp && ((level.side === 'BELOW' && at >= ltp) || (level.side === 'ABOVE' && at <= ltp))) {
      throw new ValidationError(`This level must stay ${level.side === 'BELOW' ? 'below' : 'above'} the current price (${ltp}) - place a new one instead`);
    }
    const distance = level.kind === 'TRAIL' ? Math.abs((Number(level.best_price) || ltp || at) - at) : level.trail_distance;
    await db.run(
      'UPDATE exit_levels SET trigger_price = ?, trail_distance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [at, distance, id]
    );
    this.crossSince.delete(id);
    return this.get(id);
  }

  async cancel(id) {
    const res = await db.run(
      "UPDATE exit_levels SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE'",
      [id]
    );
    if (!res.changes) throw new NotFoundError('Active exit level');
    this.crossSince.delete(id);
    return { id, status: 'CANCELLED' };
  }

  /** Active levels on a chart row, plus what fired in the last day. */
  async list(symbolId) {
    const row = await this._row(symbolId);
    const rows = await db.all(
      `SELECT * FROM exit_levels WHERE symbol_id = ?
         AND (status = 'ACTIVE' OR (status IN ('TRIGGERED', 'TRIGGERING') AND triggered_at >= datetime('now', '-1 day')))
       ORDER BY trigger_price DESC`,
      [row.id]
    );
    const out = [];
    for (const level of rows) out.push({ ...level, ...(await this.describe(level, row)) });
    return out;
  }

  // ---------------------------------------------------------------- projections

  /**
   * Estimated option premium at each active level - "≈ ₹142 if NIFTY 22,680". Black-76, with the
   * volatility backed out of the option's current price at the current underlying price. An
   * estimate: the trigger is the underlying's price, not this number.
   */
  async projections(symbolId, contracts = []) {
    const row = await this._row(symbolId);
    const levels = await db.all("SELECT * FROM exit_levels WHERE symbol_id = ? AND status = 'ACTIVE'", [row.id]);
    const spot = await this._currentPrice(row.exchange, row.symbol);
    if (!levels.length || !spot) return [];
    const out = [];
    for (const c of contracts.slice(0, 4)) {
      const inst = await db.get(
        "SELECT symbol, exchange, instrumenttype, strike, expiry FROM instruments WHERE UPPER(exchange) = ? AND UPPER(symbol) = ? AND instrumenttype IN ('CE','PE') LIMIT 1",
        [upper(c.exchange), upper(c.symbol)]
      );
      if (!inst || isContractExpired(inst)) continue;
      const premium = await this._currentPrice(inst.exchange, inst.symbol);
      const T = parseExpiryToYearFraction(contractExpiry(inst));
      if (!premium || !T) continue;
      const isCall = inst.instrumenttype === 'CE';
      const r = riskFreeRateForSymbol(row.symbol);
      const iv = impliedVolBlack76(premium, spot, Number(inst.strike), T, r, isCall);
      for (const level of levels) {
        const at = Number(level.trigger_price);
        const estimate = iv > 0
          ? black76Price(at, Number(inst.strike), T, r, iv, isCall)
          : Math.max(0, isCall ? at - inst.strike : inst.strike - at);
        out.push({ levelId: level.id, symbol: inst.symbol, underlying: at, estimate: Math.round(estimate * 100) / 100, iv: iv > 0 ? iv : null });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- evaluation

  /** Called every auto-exit cycle. Never throws. */
  async evaluate() {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const levels = await db.all("SELECT * FROM exit_levels WHERE status = 'ACTIVE'").catch(() => []);
      const byRef = new Map();
      for (const l of levels) {
        const k = `${l.ref_exchange}|${l.ref_symbol}`;
        (byRef.get(k) || byRef.set(k, []).get(k)).push(l);
      }
      for (const [k, group] of byRef) {
        const [exchange, symbol] = k.split('|');
        if (!(await this._isOpen(exchange))) { group.forEach((l) => this.crossSince.delete(l.id)); continue; }
        const ltp = this._freshPrice(exchange, symbol);
        if (!ltp) {
          marketDataFeedService.ensureSymbolSubscribed(exchange, symbol);
          this._warnStale(k, group.length);
          group.forEach((l) => this.crossSince.delete(l.id));
          continue;
        }
        for (const level of group) await this._evaluateLevel(level, ltp);
      }
    } catch (error) {
      log.error('Exit level evaluation failed', error);
    } finally {
      this.evaluating = false;
    }
  }

  _warnStale(key, count) {
    const last = this.staleWarnedAt.get(key) || 0;
    if (Date.now() - last < STALE_WARN_MS) return;
    this.staleWarnedAt.set(key, Date.now());
    log.warn('Exit levels waiting for a fresh price - not triggering on a stale one', {
      symbol: key.split('|')[1], exchange: key.split('|')[0], count,
    });
  }

  async _evaluateLevel(level, ltp) {
    let trigger = Number(level.trigger_price);
    if (level.kind === 'TRAIL') {
      const next = trail({ side: level.side, best: level.best_price, trigger, distance: level.trail_distance }, ltp);
      if (next.best !== level.best_price || next.trigger !== trigger) {
        await db.run('UPDATE exit_levels SET best_price = ?, trigger_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [next.best, next.trigger, level.id]);
        trigger = next.trigger;
      }
    }
    if (!hasCrossed(level.side, trigger, ltp)) {
      this.crossSince.delete(level.id);
      return;
    }
    const since = this.crossSince.get(level.id) || Date.now();
    this.crossSince.set(level.id, since);
    if (Date.now() - since < CONFIRM_MS) return;
    this.crossSince.delete(level.id);
    await this.fire({ ...level, trigger_price: trigger }, ltp);
  }

  /** Exit what the level covers, once. Returns the per-position results. */
  async fire(level, ltp) {
    const claim = await db.run(
      "UPDATE exit_levels SET status = 'TRIGGERING', triggered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE'",
      [level.id]
    );
    if (!claim.changes) return null; // another cycle got it

    const results = [];
    try {
      const row = await this._row(level.symbol_id);
      const keys = await this._keys(row);
      const instances = await this._instances(level.watchlist_id, level.instance_ids);
      const live = await marketDataFeedService.fetchPositionsForInstances(instances, { forceLive: true });
      const books = new Map();
      for (const inst of instances) {
        const r = live.get(inst.id);
        if (!r?.success) results.push({ instance: inst.name, ok: false, error: `position book unreadable: ${r?.error || 'no answer'}` });
        books.set(inst.id, r?.success ? r.positions || [] : []);
      }
      const covered = await this._covered(level, keys, instances, books);
      const closed = new Set();
      for (const c of covered) {
        const exitQty = exitQuantity(c.qty, c.lot, level.size_mode, level.size_value);
        if (!exitQty) continue;
        const symbol = upper(c.position.symbol || c.position.tradingsymbol);
        const exchange = upper(c.position.exchange || c.position.exch);
        const tag = `${c.instance.id}|${exchange}|${symbol}|${upper(c.position.product)}`;
        const entry = { instance: c.instance.name, symbol, role: c.role, direction: c.direction, qty: exitQty };
        try {
          if (exitQty >= Math.abs(c.qty)) {
            if (closed.has(tag)) continue; // one close already took this product row
            closed.add(tag);
            await quickOrderService.closePosition(
              c.instance,
              { symbol, exchange },
              { tradeMode: c.type === 'CE' || c.type === 'PE' ? 'OPTIONS' : c.type === 'FUT' ? 'FUTURES' : 'EQUITY', product: c.position.product, onlyProduct: true, strategy: 'EXIT_LEVEL' }
            );
          } else if (live.get(c.instance.id)?.fromCache) {
            // A partial size is computed from the quantity held - never from a cached book.
            throw new Error('live position book unavailable - partial exit not sent');
          } else {
            await quickOrderService.exitPartOfPosition(c.instance, { symbol, exchange, product: c.position.product, quantity: c.qty }, exitQty);
          }
          results.push({ ...entry, ok: true });
        } catch (error) {
          results.push({ ...entry, ok: false, error: error.message });
        }
      }
    } catch (error) {
      results.push({ ok: false, error: error.message });
    }

    await db.run(
      "UPDATE exit_levels SET status = 'TRIGGERED', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify({ ltp, trigger: level.trigger_price, results }), level.id]
    );
    if (level.size_mode === 'FULL') {
      // The pair's other half has nothing left to protect: cancel it.
      await db.run(
        `UPDATE exit_levels SET status = 'CANCELLED', result = ?, updated_at = CURRENT_TIMESTAMP
          WHERE status = 'ACTIVE' AND watchlist_id = ? AND ref_exchange = ? AND ref_symbol = ? AND side != ?`,
        [JSON.stringify({ reason: 'cancelled when the opposite level exited in full', by: level.id }),
          level.watchlist_id, level.ref_exchange, level.ref_symbol, level.side]
      );
    }
    await this._announce(level, ltp, results);
    return results;
  }

  async _announce(level, ltp, results) {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const summary = `${level.ref_symbol} ${level.kind === 'TRAIL' ? 'trailing stop' : 'level'} ${level.trigger_price} hit at ${ltp}: `
      + `${ok} exit${ok === 1 ? '' : 's'} sent${failed.length ? `, ${failed.length} failed (${failed[0].error})` : ''}`;
    log.warn('Exit level triggered', { symbol: level.ref_symbol, exchange: level.ref_exchange, reason: summary });
    if (!config.telegram?.botToken) return;
    const { default: telegramService } = await import('./telegram.service.js');
    await telegramService.broadcastText(`*EXIT LEVEL*\n${summary}`).catch(() => {});
  }

}

export { SIDES, CONFIRM_MS, upper, qtyOf };
export default new ExitLevelsService();
