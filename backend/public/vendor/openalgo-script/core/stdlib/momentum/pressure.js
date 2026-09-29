import { NONE, at, fold, held, hl2, hlc3, isPresent, result, tailOf } from '../values/index.js';
import { smaStep } from '../averages/index.js';
import { sumStep } from '../series/index.js';
import { meanDeviationStep } from '../volatility/index.js';
/**
 * `cci(len)`: how far the typical price sits from its mean in mean-deviation
 * units, from bar `len - 1`.
 *
 * The divisor is the **mean absolute deviation**, not the standard deviation.
 * The 0.015 constant is calibrated against that quantity, and substituting a
 * standard deviation changes every reading while still producing a plausible
 * looking line.
 */
export function cciStep(state, key, bar, len) {
    const typical = hlc3(bar);
    const mean = smaStep(state, `${key}q`, typical, len);
    const deviation = meanDeviationStep(state, `${key}v`, typical, len);
    if (!isPresent(typical) || !isPresent(mean) || !isPresent(deviation))
        return NONE;
    if (deviation === 0)
        return NONE;
    return result((typical - mean) / (0.015 * deviation));
}
/** `cci(len)` as a tail. */
export function cciTail(len = 20) {
    return tailOf((state, bar) => cciStep(state, '', bar, len));
}
/** `cci(len)` over a run of bars. */
export function cci(bars, len = 20) {
    return fold(cciTail(len), bars);
}
/**
 * `ultimateOsc(len1, len2, len3)`: buying pressure blended over three lookbacks,
 * from bar `max(len1, len2, len3)`.
 *
 * Buying pressure is the close above the lower of this bar's low and the
 * previous close, over the range between the higher of this bar's high and that
 * close and the same lower bound. Both need the previous close, so the sums
 * start at bar 1 and the first reading is at bar `max`, not `max - 1`.
 *
 * The weights are 4, 2 and 1 over 7, shortest lookback heaviest, which is what
 * stops any single length dominating the reading.
 */
export function ultimateOscStep(state, key, bar, len1, len2, len3) {
    const closeKey = `${key}p`;
    const seenKey = `${key}k`;
    const previousClose = held(state, closeKey);
    const started = state[seenKey] === true;
    let pressure = NONE;
    let range = NONE;
    if (started &&
        isPresent(previousClose) &&
        isPresent(bar.high) &&
        isPresent(bar.low) &&
        isPresent(bar.close)) {
        const floorOf = Math.min(bar.low, previousClose);
        const ceilingOf = Math.max(bar.high, previousClose);
        pressure = result(bar.close - floorOf);
        range = result(ceilingOf - floorOf);
    }
    state[seenKey] = true;
    state[closeKey] = bar.close;
    const lengths = [len1, len2, len3];
    const averages = [];
    for (let index = 0; index < 3; index += 1) {
        const len = lengths[index] ?? null;
        const top = sumStep(state, `${key}t${index}`, pressure, len);
        const bottom = sumStep(state, `${key}b${index}`, range, len);
        averages.push(isPresent(top) && isPresent(bottom) && bottom !== 0 ? result(top / bottom) : NONE);
    }
    const fast = at(averages, 0);
    const middle = at(averages, 1);
    const slow = at(averages, 2);
    if (!isPresent(fast) || !isPresent(middle) || !isPresent(slow))
        return NONE;
    return result((100 * (4 * fast + 2 * middle + slow)) / 7);
}
/** `ultimateOsc(len1, len2, len3)` as a tail. */
export function ultimateOscTail(len1 = 7, len2 = 14, len3 = 28) {
    return tailOf((state, bar) => ultimateOscStep(state, '', bar, len1, len2, len3));
}
/** `ultimateOsc(len1, len2, len3)` over a run of bars. */
export function ultimateOsc(bars, len1 = 7, len2 = 14, len3 = 28) {
    return fold(ultimateOscTail(len1, len2, len3), bars);
}
/** `awesomeOsc(fast, slow)`: the difference of two simple means of `hl2`, from bar `slow - 1`. */
export function awesomeOscStep(state, key, bar, fast, slow) {
    const midpoint = hl2(bar);
    const near = smaStep(state, `${key}f`, midpoint, fast);
    const far = smaStep(state, `${key}s`, midpoint, slow);
    if (!isPresent(near) || !isPresent(far))
        return NONE;
    return result(near - far);
}
/** `awesomeOsc(fast, slow)` as a tail. */
export function awesomeOscTail(fast = 5, slow = 34) {
    return tailOf((state, bar) => awesomeOscStep(state, '', bar, fast, slow));
}
/** `awesomeOsc(fast, slow)` over a run of bars. */
export function awesomeOsc(bars, fast = 5, slow = 34) {
    return fold(awesomeOscTail(fast, slow), bars);
}
//# sourceMappingURL=pressure.js.map