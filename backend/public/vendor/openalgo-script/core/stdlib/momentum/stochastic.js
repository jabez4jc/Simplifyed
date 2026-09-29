import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { smaStep } from '../averages/index.js';
import { extremeStep } from '../series/index.js';
import { rsiStep } from './rsi.js';
/** Where `value` sits between `low` and `high`, as 0 to 100. Absent on a flat range. */
function position(value, high, low) {
    if (!isPresent(value) || !isPresent(high) || !isPresent(low))
        return NONE;
    const span = high - low;
    if (span === 0)
        return NONE;
    return result((100 * (value - low)) / span);
}
/** The largest value in the last `len` bars, as the three studies here read it. */
function topStep(state, key, value, len) {
    return extremeStep(state, key, value, len, true, false);
}
/** The smallest value in the last `len` bars. */
function bottomStep(state, key, value, len) {
    return extremeStep(state, key, value, len, false, false);
}
/** The raw range position of a series against its own lookback. */
function rawStep(state, key, value, len) {
    const high = topStep(state, `${key}t`, value, len);
    const low = bottomStep(state, `${key}b`, value, len);
    return position(value, high, low);
}
/**
 * `stoch(len, smoothK, smoothD)`: `[k, d]`, element 0 from bar
 * `len + smoothK - 2` and element 1 from bar `len + smoothK + smoothD - 3`.
 *
 * The close against the lookback's outright high and low, which are the bars'
 * highs and lows and not the close's own extremes.
 */
export function stochStep(state, key, bar, len, smoothK, smoothD) {
    const high = topStep(state, `${key}t`, bar.high, len);
    const low = bottomStep(state, `${key}b`, bar.low, len);
    const raw = position(bar.close, high, low);
    const k = smaStep(state, `${key}k`, raw, smoothK);
    const d = smaStep(state, `${key}d`, k, smoothD);
    return [k, d];
}
/** `stoch(len, smoothK, smoothD)` as a tail. */
export function stochTail(len = 14, smoothK = 1, smoothD = 3) {
    return tailOf((state, bar) => stochStep(state, '', bar, len, smoothK, smoothD));
}
/** `stoch(len, smoothK, smoothD)` over a run of bars. */
export function stoch(bars, len = 14, smoothK = 1, smoothD = 3) {
    return fold(stochTail(len, smoothK, smoothD), bars);
}
/**
 * `stochRsi(src, rsiLen, stochLen, smoothK, smoothD)`: `[k, d]`, element 0 from
 * bar `rsiLen + stochLen + smoothK - 2`.
 *
 * The same position test applied to `rsi` rather than to price, so the lookback
 * is the range the strength reading itself covered.
 */
export function stochRsiStep(state, key, value, rsiLen, stochLen, smoothK, smoothD) {
    const strength = rsiStep(state, `${key}r`, value, rsiLen);
    const raw = rawStep(state, `${key}p`, strength, stochLen);
    const k = smaStep(state, `${key}k`, raw, smoothK);
    const d = smaStep(state, `${key}d`, k, smoothD);
    return [k, d];
}
/** `stochRsi(src, rsiLen, stochLen, smoothK, smoothD)` as a tail. */
export function stochRsiTail(rsiLen = 14, stochLen = 14, smoothK = 3, smoothD = 3) {
    return tailOf((state, value) => stochRsiStep(state, '', value, rsiLen, stochLen, smoothK, smoothD));
}
/** `stochRsi(src, rsiLen, stochLen, smoothK, smoothD)` over a whole series. */
export function stochRsi(src, rsiLen = 14, stochLen = 14, smoothK = 3, smoothD = 3) {
    return fold(stochRsiTail(rsiLen, stochLen, smoothK, smoothD), src);
}
/**
 * `williamsR(len)`: the same position scaled 0 to -100, from bar `len - 1`.
 *
 * Zero at the top of the range and -100 at the bottom, which is the sign
 * convention the reading has always carried.
 */
export function williamsRStep(state, key, bar, len) {
    const high = topStep(state, `${key}t`, bar.high, len);
    const low = bottomStep(state, `${key}b`, bar.low, len);
    if (!isPresent(bar.close) || !isPresent(high) || !isPresent(low))
        return NONE;
    const span = high - low;
    if (span === 0)
        return NONE;
    return result((-100 * (high - bar.close)) / span);
}
/** `williamsR(len)` as a tail. */
export function williamsRTail(len = 14) {
    return tailOf((state, bar) => williamsRStep(state, '', bar, len));
}
/** `williamsR(len)` over a run of bars. */
export function williamsR(bars, len = 14) {
    return fold(williamsRTail(len), bars);
}
//# sourceMappingURL=stochastic.js.map