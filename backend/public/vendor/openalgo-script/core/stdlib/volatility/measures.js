import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { extremeStep, historyStep, sumStep } from '../series/index.js';
import { log, log10 } from '../maths/index.js';
import { gapOf, trueRangeOf } from './range.js';
import { stdevStep } from './deviation.js';
/**
 * `chop(len)`: a 0 to 100 reading of whether the lookback trended or chopped,
 * from bar `len`.
 *
 * The distance price actually travelled over the lookback, against the outright
 * range it covered. A market that went straight there travels its range and
 * reads low; one that went back and forth travels several times its range and
 * reads high.
 *
 * The travel is a sum of `len` true ranges, and a true range needs the bar
 * before it, which is why the first reading is at bar `len` and not at bar
 * `len - 1`: the gap-aware form of true range is the one used here, per the
 * note in `range.ts`. The previous close arrives with the gap rather than being
 * remembered here, for the reason the same note gives.
 */
export function chopStep(state, key, gap, len) {
    const distance = sumStep(state, `${key}s`, trueRangeOf(gap, false), len);
    const upper = extremeStep(state, `${key}h`, gap.high, len, true, false);
    const lower = extremeStep(state, `${key}l`, gap.low, len, false, false);
    if (len === null)
        return NONE;
    if (!isPresent(distance) || !isPresent(upper) || !isPresent(lower))
        return NONE;
    const span = upper - lower;
    const scale = log10(len);
    if (!(span > 0) || !(distance > 0) || !isPresent(scale) || scale === 0)
        return NONE;
    const travelled = log10(distance / span);
    return isPresent(travelled) ? result((100 * travelled) / scale) : NONE;
}
/** `chop(len)` as a tail. */
export function chopTail(len = 14) {
    return tailOf((state, bar) => chopStep(state, '', gapOf(state, 'g', bar), len));
}
/** `chop(len)` over a run of bars. */
export function chop(bars, len = 14) {
    return fold(chopTail(len), bars);
}
/**
 * `hv(src, len, periodsPerYear)`: the annualised standard deviation of log
 * returns, from bar `len`.
 *
 * A log return needs the previous bar, so the deviation's lookback starts at bar
 * 1 and its first value is at bar `len`, one later than a lookback over levels.
 *
 * The result is a proportion, not a percentage: `stdlib.md` section 6 says
 * "annualised standard deviation of log returns" and nothing about scaling it
 * by a hundred, so nothing here does. A study that wants a percentage axis
 * multiplies at the plot, where a reader can see it happen.
 */
export function hvStep(state, key, value, len, periodsPerYear) {
    const previous = historyStep(state, `${key}h`, value, 1);
    let logReturn = NONE;
    if (isPresent(value) && isPresent(previous) && value > 0 && previous > 0) {
        logReturn = log(value / previous);
    }
    const deviation = stdevStep(state, `${key}q`, logReturn, len, false);
    if (!isPresent(deviation) || periodsPerYear === null || !(periodsPerYear > 0))
        return NONE;
    return result(deviation * Math.sqrt(periodsPerYear));
}
/** `hv(src, len, periodsPerYear)` as a tail. */
export function hvTail(len = 20, periodsPerYear = 252) {
    return tailOf((state, value) => hvStep(state, '', value, len, periodsPerYear));
}
/** `hv(src, len, periodsPerYear)` over a whole series. */
export function hv(src, len = 20, periodsPerYear = 252) {
    return fold(hvTail(len, periodsPerYear), src);
}
//# sourceMappingURL=measures.js.map