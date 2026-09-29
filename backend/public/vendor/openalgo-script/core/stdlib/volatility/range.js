import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { rmaStep } from '../averages/index.js';
/** `trueRange()`: the bar's range including any gap from the previous close. */
export function trueRangeOf(gap, allowFirstBar) {
    if (gap.isFirstBar) {
        return allowFirstBar && isPresent(gap.high) && isPresent(gap.low)
            ? result(gap.high - gap.low)
            : NONE;
    }
    if (!isPresent(gap.high) || !isPresent(gap.low) || !isPresent(gap.previousClose))
        return NONE;
    const within = gap.high - gap.low;
    const upGap = Math.abs(gap.high - gap.previousClose);
    const downGap = Math.abs(gap.low - gap.previousClose);
    return result(Math.max(within, upGap, downGap));
}
/**
 * The previous close remembered in a region, for a caller folding over a run of
 * bars rather than being handed one at a time.
 */
export function gapOf(state, key, bar) {
    const closeKey = `${key}p`;
    const seenKey = `${key}k`;
    const held = state[closeKey];
    const gap = {
        high: bar.high,
        low: bar.low,
        previousClose: typeof held === 'number' ? held : NONE,
        isFirstBar: state[seenKey] !== true,
    };
    state[seenKey] = true;
    state[closeKey] = bar.close;
    return gap;
}
/** `trueRange()` as a tail. */
export function trueRangeTail() {
    return tailOf((state, bar) => trueRangeOf(gapOf(state, 'g', bar), true));
}
/**
 * True range with no exception on bar 0, as a step: absent there, like any
 * other quantity that needs the bar before it. Not a call a script can make;
 * see this file's opening note for which functions use it and why.
 */
export function gapTrueRangeStep(state, key, bar) {
    return trueRangeOf(gapOf(state, `${key}g`, bar), false);
}
/** `trueRange()` over a run of bars. */
export function trueRange(bars) {
    return fold(trueRangeTail(), bars);
}
/** The gap-aware true range as a tail. */
export function gapTrueRangeTail() {
    return tailOf((state, bar) => gapTrueRangeStep(state, '', bar));
}
/** The gap-aware true range over a run of bars. */
export function gapTrueRange(bars) {
    return fold(gapTrueRangeTail(), bars);
}
/** `atr(len)`: the smoothed mean of true range, from bar `len - 1`. */
export function atrStep(state, key, gap, len) {
    return rmaStep(state, `${key}a`, trueRangeOf(gap, true), len);
}
/** `atr(len)` as a tail. */
export function atrTail(len) {
    return tailOf((state, bar) => atrStep(state, '', gapOf(state, 'g', bar), len));
}
/** `atr(len)` over a run of bars. */
export function atr(bars, len = 14) {
    return fold(atrTail(len), bars);
}
/** `natr(len)`: `atr` as a percentage of close, from bar `len - 1`. */
export function natrStep(state, key, gap, close, len) {
    const average = atrStep(state, key, gap, len);
    if (!isPresent(average) || !isPresent(close) || close === 0)
        return NONE;
    return result((100 * average) / close);
}
/** `natr(len)` as a tail. */
export function natrTail(len) {
    return tailOf((state, bar) => natrStep(state, '', gapOf(state, 'g', bar), bar.close, len));
}
/** `natr(len)` over a run of bars. */
export function natr(bars, len = 14) {
    return fold(natrTail(len), bars);
}
//# sourceMappingURL=range.js.map