/**
 * The rules an exit level on the underlying runs by - pure, so they can be tested without a
 * database or a broker. See services/exit-levels.service.js for how they are applied.
 */

/**
 * Which way a position makes money when the underlying moves.
 *   long underlying (equity / future), long CE, short PE   -> BULLISH
 *   short underlying,                   long PE, short CE  -> BEARISH
 * @param {string} type 'CE' | 'PE' | anything else (the underlying itself)
 * @param {number} qty signed net quantity
 * @returns {'BULLISH'|'BEARISH'|null}
 */
export function positionDirection(type, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q === 0) return null;
  const t = String(type || '').toUpperCase();
  const long = q > 0;
  if (t === 'PE') return long ? 'BEARISH' : 'BULLISH';
  return long ? 'BULLISH' : 'BEARISH'; // CE, futures, equity
}

/**
 * What a level is FOR a position of this direction: below the price it stops out bullish
 * positions and takes profit on bearish ones; above the price, the reverse.
 */
export function roleFor(side, direction) {
  if (side === 'BELOW') return direction === 'BULLISH' ? 'STOP' : 'TARGET';
  return direction === 'BULLISH' ? 'TARGET' : 'STOP';
}

/** Does a level with this coverage act on a position of this direction? */
export function covers(coverage, direction) {
  if (!direction) return false;
  return coverage === 'ALL' || coverage === direction;
}

/** A trailing stop protects one side only: below the price bullish, above the price bearish. */
export function trailCoverage(side) {
  return side === 'BELOW' ? 'BULLISH' : 'BEARISH';
}

/** Has the price reached the level from the side it was placed on? */
export function hasCrossed(side, triggerPrice, ltp) {
  const p = Number(ltp);
  const t = Number(triggerPrice);
  if (!(p > 0) || !(t > 0)) return false;
  return side === 'BELOW' ? p <= t : p >= t;
}

/**
 * A trailing stop's new state after a price: it follows the best price since it was set
 * (highest for a stop below, lowest for a stop above) and never moves back.
 * @returns {{ best: number, trigger: number }}
 */
export function trail({ side, best, trigger, distance }, ltp) {
  const p = Number(ltp);
  const d = Number(distance);
  if (!(p > 0) || !(d > 0)) return { best, trigger };
  if (side === 'BELOW') {
    const b = Math.max(Number(best) || p, p);
    return { best: b, trigger: Math.max(Number(trigger) || 0, b - d) };
  }
  const b = Math.min(Number(best) || p, p);
  const t = Number(trigger) > 0 ? Math.min(Number(trigger), b + d) : b + d;
  return { best: b, trigger: t };
}

/**
 * How much of a position to exit, in units, rounded DOWN to whole lots.
 *   FULL     the whole position
 *   PERCENT  size% of it - at least one lot while at least one lot is held
 *   LOTS     size lots, capped at the position
 * @returns {number} units to exit (0 = nothing)
 */
export function exitQuantity(qty, lotSize, sizeMode, sizeValue) {
  const held = Math.abs(Number(qty) || 0);
  const lot = Math.max(1, Number(lotSize) || 1);
  if (!held) return 0;
  if (sizeMode === 'PERCENT') {
    const pct = Math.min(100, Math.max(0, Number(sizeValue) || 0));
    if (pct >= 100) return held;
    const lots = Math.floor((held * pct) / 100 / lot);
    return Math.min(held, Math.max(held >= lot ? 1 : 0, lots) * lot);
  }
  if (sizeMode === 'LOTS') {
    const lots = Math.max(0, Math.floor(Number(sizeValue) || 0));
    return Math.min(held, lots * lot);
  }
  return held;
}
