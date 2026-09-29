import { NONE, flag, fold, hl2, isPresent, result, slot, tailOf } from '../values/index.js';
import { atrStep, gapOf } from '../volatility/index.js';
/** `supertrend(factor, atrLen)`. */
export function supertrendStep(state, key, gap, close, factor, atrLen) {
    const width = atrStep(state, key, gap, atrLen);
    const midpoint = hl2(gap);
    if (!isPresent(width) || !isPresent(midpoint) || !isPresent(close) || factor === null) {
        return [NONE, NONE];
    }
    const rawUpper = midpoint + factor * width;
    const rawLower = midpoint - factor * width;
    const seeded = flag(state, `${key}k`);
    const previousUpper = slot(state, `${key}pu`, 0);
    const previousLower = slot(state, `${key}pl`, 0);
    const previousClose = slot(state, `${key}pc`, 0);
    let followingUpper = state[`${key}fu`] !== false;
    // The band holds where it is unless price broke it or it moved inward.
    const upper = !seeded
        ? rawUpper
        : rawUpper < previousUpper || previousClose > previousUpper
            ? rawUpper
            : previousUpper;
    const lower = !seeded
        ? rawLower
        : rawLower > previousLower || previousClose < previousLower
            ? rawLower
            : previousLower;
    let line;
    if (!seeded || followingUpper) {
        if (close <= upper) {
            line = upper;
            followingUpper = true;
        }
        else {
            line = lower;
            followingUpper = false;
        }
    }
    else if (close >= lower) {
        line = lower;
        followingUpper = false;
    }
    else {
        line = upper;
        followingUpper = true;
    }
    const first = !seeded;
    state[`${key}k`] = true;
    state[`${key}pu`] = upper;
    state[`${key}pl`] = lower;
    state[`${key}pc`] = close;
    state[`${key}fu`] = followingUpper;
    if (first)
        return [NONE, NONE];
    return [result(line), followingUpper ? 1 : -1];
}
/** `supertrend(factor, atrLen)` as a tail. */
export function supertrendTail(factor = 3, atrLen = 10) {
    return tailOf((state, bar) => supertrendStep(state, '', gapOf(state, 'g', bar), bar.close, factor, atrLen));
}
/** `supertrend(factor, atrLen)` over a run of bars. */
export function supertrend(bars, factor = 3, atrLen = 10) {
    return fold(supertrendTail(factor, atrLen), bars);
}
//# sourceMappingURL=supertrend.js.map