import { NONE, isPresent, result } from '../values/index.js';
/** The nearest whole number, halves away from zero. */
export function roundHalfAway(x) {
    const below = Math.floor(x);
    const fraction = x - below;
    if (fraction > 0.5)
        return below + 1;
    if (fraction < 0.5)
        return below;
    // Exactly a half. Away from zero: upward above zero, and `below` already is
    // the downward answer for a negative, since floor(-2.5) is -3.
    return x > 0 ? below + 1 : below;
}
/** `round(x)`: to the nearest whole number, halves away from zero. */
export function round(x) {
    return isPresent(x) ? result(roundHalfAway(x)) : NONE;
}
/**
 * Ten to each whole power a binary64 can hold, as the binary64 nearest to it.
 *
 * `stdlib.md` 20.7: the scale a fixed decimal rounding or conversion multiplies
 * by is the nearest binary64 to the power of ten, the value the literal `1e23`
 * reads as, and not what a floating point power returns, which is an ulp away
 * from it for one count on this engine's host. Built once from exact integer
 * arithmetic, and it is the one table: `text(x, decimals)` in the engine's
 * library scales by it through `scaleOf` rather than holding a copy.
 */
const POWERS_OF_TEN = Array.from({ length: 309 }, (_, count) => Number(10n ** BigInt(count)));
/**
 * The scale for a digit count: the nearest binary64 to ten to that power, and
 * past the last finite power the infinity the power would have been.
 */
export function scaleOf(decimals) {
    return POWERS_OF_TEN[decimals] ?? Infinity;
}
/**
 * `round(x, decimals)`: to a fixed number of decimals, halves away from zero.
 *
 * A digit count is a whole number of zero or more; anything else is OS3004 or
 * OS4003 before the call reaches here, and absence is the backstop.
 */
export function roundTo(x, decimals) {
    if (!isPresent(x))
        return NONE;
    if (!Number.isInteger(decimals) || decimals < 0)
        return NONE;
    const scale = scaleOf(decimals);
    return result(roundHalfAway(x * scale) / scale);
}
/** `floor(x)`: toward negative infinity. */
export function floor(x) {
    return isPresent(x) ? result(Math.floor(x)) : NONE;
}
/** `ceil(x)`: toward positive infinity. */
export function ceil(x) {
    return isPresent(x) ? result(Math.ceil(x)) : NONE;
}
/** `trunc(x)`: toward zero. */
export function trunc(x) {
    return isPresent(x) ? result(Math.trunc(x)) : NONE;
}
/** `roundToStep(x, step)`: to the nearest multiple of `step`. */
export function roundToStep(x, step) {
    if (!isPresent(x) || !isPresent(step) || step <= 0)
        return NONE;
    return result(roundHalfAway(x / step) * step);
}
/**
 * `roundToTick(price)`: to the instrument's tick.
 *
 * Absent when the host supplied no tick size, rather than the price unrounded.
 * Returning the input would produce an order price that looks rounded and is
 * not, which is a defect nothing downstream can see.
 */
export function roundToTick(price, tickSize) {
    if (!isPresent(tickSize) || tickSize <= 0)
        return NONE;
    return roundToStep(price, tickSize);
}
//# sourceMappingURL=rounding.js.map