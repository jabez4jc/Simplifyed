/**
 * Risk Controls Service
 * Handles target/stoploss/trailing evaluations for auto-exit workflows.
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import riskEventsService from './risk-events.service.js';

class RiskControlsService {
  constructor() {
    this.trailingState = new Map();
    this.hydrated = false;
  }

  async evaluateExit({ key, side, currentPrice, entryPrice, configEntry, symbol, instanceId, watchlistId, symbolId, exchange }) {
    if (!configEntry || !symbol || !currentPrice || !entryPrice) {
      return null;
    }

    const mode = this._determineMode(configEntry, symbol);
    const thresholds = this._getThresholds(configEntry, mode);
    if (!thresholds) {
      return { mode, reason: null };
    }

    const direction = side === 'LONG' ? 1 : -1;
    const targetPrice = thresholds.targetPoints
      ? entryPrice + direction * thresholds.targetPoints
      : null;
    const stopPrice = thresholds.stoplossPoints
      ? entryPrice - direction * thresholds.stoplossPoints
      : null;

    const trailingHit = await this._evaluateTrailing(
      key,
      side,
      currentPrice,
      entryPrice,
      thresholds.trailingPoints,
      thresholds.trailingActivationPoints,
      { instanceId, watchlistId, symbolId, exchange, symbol }
    );

    const targetHit = targetPrice && (
      (side === 'LONG' && currentPrice >= targetPrice) ||
      (side === 'SHORT' && currentPrice <= targetPrice)
    );
    const stopHit = stopPrice && (
      (side === 'LONG' && currentPrice <= stopPrice) ||
      (side === 'SHORT' && currentPrice >= stopPrice)
    );

    let reason = null;
    if (targetHit) reason = 'TARGET_MET';
    else if (stopHit) reason = 'STOPLOSS_HIT';
    else if (trailingHit) reason = 'TSL_HIT';

    return { mode, reason };
  }

  clearTrailingState(key) {
    if (key) {
      this.trailingState.delete(key);
      this._deletePersistedState(key).catch(() => {});
    }
  }

  reset() {
    this.trailingState.clear();
    this.hydrated = false;
  }

  async _evaluateTrailing(key, side, currentPrice, entryPrice, trailingPoints, activationPoints, context = {}) {
    if (!trailingPoints) return false;
    if (!entryPrice || entryPrice <= 0) return false;

    const profit = side === 'LONG'
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    const state = this.trailingState.get(key) || {
      highest: currentPrice,
      lowest: currentPrice,
      activated: !activationPoints,
      stopPrice: null,
    };
    state.highest = Math.max(state.highest, currentPrice);
    state.lowest = Math.min(state.lowest, currentPrice);

    if (activationPoints && !state.activated) {
      if (profit >= activationPoints) {
        state.activated = true;
        log.debug('Trailing activation reached', { key, profit, activationPoints });
      } else {
        this.trailingState.set(key, state);
        return false;
      }
    }

    if (!state.activated) {
      this.trailingState.set(key, state);
      return false;
    }

    // Ratchet: stopPrice only ever moves in the favorable direction, never retreats,
    // even if highest/lowest later swing back. This is the AFL-style trailing behavior.
    const candidateStop = side === 'LONG'
      ? state.highest - trailingPoints
      : state.lowest + trailingPoints;

    const previousStop = state.stopPrice;
    const isMoreFavorable = previousStop == null ||
      (side === 'LONG' ? candidateStop > previousStop : candidateStop < previousStop);

    if (isMoreFavorable) {
      state.stopPrice = candidateStop;
      this.trailingState.set(key, state);
      // Await so concurrent ticks for the same key can't race the persisted stop_price out of order.
      await this.persistState(key, state);
      if (previousStop != null) {
        await riskEventsService.record({
          instanceId: context.instanceId,
          watchlistId: context.watchlistId,
          symbolId: context.symbolId,
          exchange: context.exchange,
          symbol: context.symbol,
          eventType: 'STOP_RATCHET',
          previousValue: previousStop,
          newValue: candidateStop,
          metadata: { side, currentPrice, entryPrice, trailingPoints },
        });
      } else {
        await riskEventsService.record({
          instanceId: context.instanceId,
          watchlistId: context.watchlistId,
          symbolId: context.symbolId,
          exchange: context.exchange,
          symbol: context.symbol,
          eventType: 'TRAIL_ACTIVATED',
          newValue: candidateStop,
          metadata: { side, currentPrice, entryPrice, trailingPoints, activationPoints },
        });
      }
    } else {
      this.trailingState.set(key, state);
    }

    return side === 'LONG'
      ? currentPrice <= state.stopPrice
      : currentPrice >= state.stopPrice;
  }

  async hydrateFromDb() {
    if (this.hydrated) return;
    try {
      const rows = await db.all('SELECT instance_id, exchange, symbol, side, highest, lowest, activated, last_seen_ts, entry_price, entry_source, stop_price FROM trailing_state');
      for (const row of rows) {
        const key = this._key(row.instance_id, row.exchange, row.symbol, row.side);
        this.trailingState.set(key, {
          highest: row.highest ?? null,
          lowest: row.lowest ?? null,
          activated: Boolean(row.activated),
          lastSeen: row.last_seen_ts ?? Date.now(),
          entryPrice: row.entry_price ?? null,
          entrySource: row.entry_source ?? null,
          stopPrice: row.stop_price ?? null,
        });
      }
      this.hydrated = true;
      log.info('Hydrated trailing state from DB', { count: rows.length });
    } catch (err) {
      log.warn('Failed to hydrate trailing state', { error: err.message });
    }
  }

  async persistState(key, state) {
    try {
      const parsed = this._parseKey(key);
      if (!parsed) return;
      const { instanceId, exchange, symbol, side } = parsed;
      const now = Date.now();
      await db.run(
        `
          INSERT INTO trailing_state (instance_id, exchange, symbol, side, highest, lowest, activated, last_seen_ts, entry_price, entry_source, stop_price, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(instance_id, exchange, symbol, side) DO UPDATE SET
            highest=excluded.highest,
            lowest=excluded.lowest,
            activated=excluded.activated,
            last_seen_ts=excluded.last_seen_ts,
            entry_price=excluded.entry_price,
            entry_source=excluded.entry_source,
            stop_price=excluded.stop_price,
            updated_at=excluded.updated_at
        `,
        [
          instanceId,
          exchange,
          symbol,
          side,
          state.highest ?? null,
          state.lowest ?? null,
          state.activated ? 1 : 0,
          state.lastSeen ?? now,
          state.entryPrice ?? null,
          state.entrySource ?? null,
          state.stopPrice ?? null,
          now,
        ]
      );
    } catch (err) {
      log.warn('Failed to persist trailing state', { key, error: err.message });
    }
  }

  async _deletePersistedState(key) {
    const parsed = this._parseKey(key);
    if (!parsed) return;
    const { instanceId, exchange, symbol, side } = parsed;
    try {
      await db.run(
        'DELETE FROM trailing_state WHERE instance_id = ? AND exchange = ? AND symbol = ? AND side = ?',
        [instanceId, exchange, symbol, side]
      );
    } catch (err) {
      log.warn('Failed to delete trailing state', { key, error: err.message });
    }
  }

  _key(instanceId, exchange, symbol, side) {
    return `${instanceId}|${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}|${(side || '').toUpperCase()}`;
  }

  _parseKey(key) {
    const parts = String(key).split('|');
    if (parts.length !== 4) return null;
    const [instanceId, exchange, symbol, side] = parts;
    return { instanceId, exchange, symbol, side };
  }

  _getThresholds(entry, mode) {
    const normalizeValue = (value) => (typeof value === 'number' && value > 0 ? value : null);
    const targetPoints = normalizeValue(entry[`target_points_${mode}`]);
    const stoplossPoints = normalizeValue(entry[`stoploss_points_${mode}`]);
    const trailingPoints = normalizeValue(entry[`trailing_stoploss_points_${mode}`]);
    const trailingActivationPoints = normalizeValue(entry[`trailing_activation_points_${mode}`]) ?? 0;
    if (!targetPoints && !stoplossPoints && !trailingPoints) {
      return null;
    }
    return { targetPoints, stoplossPoints, trailingPoints, trailingActivationPoints };
  }

  /**
   * Which risk-column set applies: 'direct' (equity), 'futures' or 'options'.
   *
   * symbol_type is authoritative and is checked FIRST. It used to be checked last, behind
   * substring tests on the symbol name - and `symbol.includes('CE')` matches RELIAN**CE**,
   * PETRON**E**T is fine but PE**L**, **CE**SC, **CE**ATLTD, PERSIST**E**NT and A**CE** are not.
   * Every such equity was classified as 'options', so auto-exit read target_points_options /
   * stoploss_points_options for it and silently ignored anything configured on the Direct tab.
   *
   * The name heuristics remain as a fallback for rows with no symbol_type, but are now anchored:
   * a real option symbol ends in a strike followed by CE/PE (NIFTY26JUL24000CE), and a future
   * ends in FUT. Substring matching anywhere in the name is not a safe test.
   */
  _determineMode(entry, symbol) {
    const type = (entry?.symbol_type || '').toUpperCase();
    if (type === 'OPTIONS') return 'options';
    if (type === 'FUTURES' || type === 'INDEX') return 'futures';
    if (type === 'EQUITY' || type === 'EQ') return 'direct';

    const normalizedSymbol = (symbol || '').toUpperCase();
    if (/\d(CE|PE)$/.test(normalizedSymbol)) return 'options';
    if (/FUT$/.test(normalizedSymbol)) return 'futures';
    return 'direct';
  }
}

const riskControlsService = new RiskControlsService();
export default riskControlsService;
