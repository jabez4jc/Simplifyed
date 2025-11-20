/**
 * Risk Controls Service
 * Handles target/stoploss/trailing evaluations for auto-exit workflows.
 */

import { log } from '../core/logger.js';

class RiskControlsService {
  constructor() {
    this.trailingState = new Map();
  }

  evaluateExit({ key, side, currentPrice, entryPrice, configEntry, symbol }) {
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

    const trailingHit = this._evaluateTrailing(
      key,
      side,
      currentPrice,
      entryPrice,
      thresholds.trailingPoints,
      thresholds.trailingActivationPoints
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
    }
  }

  reset() {
    this.trailingState.clear();
  }

  _evaluateTrailing(key, side, currentPrice, entryPrice, trailingPoints, activationPoints) {
    if (!trailingPoints) return false;
    if (!entryPrice || entryPrice <= 0) return false;

    const profit = side === 'LONG'
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    const state = this.trailingState.get(key) || {
      highest: currentPrice,
      lowest: currentPrice,
      activated: !activationPoints,
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

    if (side === 'LONG') {
      const trigger = state.highest - trailingPoints;
      this.trailingState.set(key, state);
      return currentPrice <= trigger;
    }

    const trigger = state.lowest + trailingPoints;
    this.trailingState.set(key, state);
    return currentPrice >= trigger;
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

  _determineMode(entry, symbol) {
    const normalizedSymbol = (symbol || '').toUpperCase();
    if (normalizedSymbol.includes('CE') || normalizedSymbol.includes('PE')) {
      return 'options';
    }
    if (normalizedSymbol.includes('FUT')) {
      return 'futures';
    }
    const type = (entry.symbol_type || '').toUpperCase();
    if (type === 'OPTIONS') {
      return 'options';
    }
    if (type === 'FUTURES' || type === 'INDEX') {
      return 'futures';
    }
    return 'direct';
  }
}

const riskControlsService = new RiskControlsService();
export default riskControlsService;
