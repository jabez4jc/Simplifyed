import { NONE, at, fold, isPresent, result, tailOf } from '../values/index.js';
import { maStep, smaStep } from '../averages/index.js';
import { extremeStep } from '../series/index.js';
import { stdevStep } from './deviation.js';
import { atrStep, gapOf } from './range.js';
/** `bollinger(src, len, mult)`: `[basis, upper, lower]`, all from bar `len - 1`. */
export function bollingerStep(state, key, value, len, mult) {
    const middle = smaStep(state, `${key}q`, value, len);
    const deviation = stdevStep(state, `${key}d`, value, len, false);
    if (!isPresent(middle) || !isPresent(deviation) || mult === null)
        return [middle, NONE, NONE];
    return [middle, result(middle + mult * deviation), result(middle - mult * deviation)];
}
/** `bollinger(src, len, mult)` as a tail. */
export function bollingerTail(len = 20, mult = 2) {
    return tailOf((state, value) => bollingerStep(state, '', value, len, mult));
}
/** `bollinger(src, len, mult)` over a whole series. */
export function bollinger(src, len = 20, mult = 2) {
    return fold(bollingerTail(len, mult), src);
}
/** `bbWidth(src, len, mult)`: band width over the basis, from bar `len - 1`. */
export function bbWidthStep(state, key, value, len, mult) {
    const trio = bollingerStep(state, key, value, len, mult);
    const basis = at(trio, 0);
    const upper = at(trio, 1);
    const lower = at(trio, 2);
    if (!isPresent(basis) || !isPresent(upper) || !isPresent(lower))
        return NONE;
    if (basis === 0)
        return NONE;
    return result((upper - lower) / basis);
}
/** `bbWidth(src, len, mult)` as a tail. */
export function bbWidthTail(len = 20, mult = 2) {
    return tailOf((state, value) => bbWidthStep(state, '', value, len, mult));
}
/** `bbWidth(src, len, mult)` over a whole series. */
export function bbWidth(src, len = 20, mult = 2) {
    return fold(bbWidthTail(len, mult), src);
}
/** `bbPercent(src, len, mult)`: where price sits between the bands, from bar `len - 1`. */
export function bbPercentStep(state, key, value, len, mult) {
    const trio = bollingerStep(state, key, value, len, mult);
    const upper = at(trio, 1);
    const lower = at(trio, 2);
    if (!isPresent(value) || !isPresent(upper) || !isPresent(lower))
        return NONE;
    const span = upper - lower;
    if (span === 0)
        return NONE;
    return result((value - lower) / span);
}
/** `bbPercent(src, len, mult)` as a tail. */
export function bbPercentTail(len = 20, mult = 2) {
    return tailOf((state, value) => bbPercentStep(state, '', value, len, mult));
}
/** `bbPercent(src, len, mult)` over a whole series. */
export function bbPercent(src, len = 20, mult = 2) {
    return fold(bbPercentTail(len, mult), src);
}
/**
 * `keltner(len, mult, atrLen, maType)`: `[basis, upper, lower]`, all from bar
 * `max(len, atrLen) - 1`.
 *
 * The same picture as `bollinger` built from average true range instead of
 * deviation, so the rails widen on how far the instrument travels rather than
 * on how dispersed its closes were.
 */
export function keltnerStep(state, key, gap, close, volume, len, mult, atrLen, maType) {
    const middle = maStep(state, `${key}m`, { src: close, volume }, len, maType);
    const width = atrStep(state, `${key}r`, gap, atrLen);
    if (!isPresent(middle) || !isPresent(width) || mult === null)
        return [middle, NONE, NONE];
    return [middle, result(middle + mult * width), result(middle - mult * width)];
}
/** `keltner(len, mult, atrLen, maType)` as a tail. */
export function keltnerTail(len = 20, mult = 2, atrLen = 10, maType = 'ema') {
    return tailOf((state, bar) => keltnerStep(state, '', gapOf(state, 'g', bar), bar.close, bar.volume, len, mult, atrLen, maType));
}
/** `keltner(len, mult, atrLen, maType)` over a run of bars. */
export function keltner(bars, len = 20, mult = 2, atrLen = 10, maType = 'ema') {
    return fold(keltnerTail(len, mult, atrLen, maType), bars);
}
/** `donchian(len)`: `[upper, basis, lower]`, all from bar `len - 1`. */
export function donchianStep(state, key, high, low, len) {
    const upper = extremeStep(state, `${key}h`, high, len, true, false);
    const lower = extremeStep(state, `${key}l`, low, len, false, false);
    if (!isPresent(upper) || !isPresent(lower))
        return [upper, NONE, lower];
    return [upper, result((upper + lower) / 2), lower];
}
/** `donchian(len)` as a tail. */
export function donchianTail(len = 20) {
    return tailOf((state, bar) => donchianStep(state, '', bar.high, bar.low, len));
}
/** `donchian(len)` over a run of bars. */
export function donchian(bars, len = 20) {
    return fold(donchianTail(len), bars);
}
//# sourceMappingURL=bands.js.map