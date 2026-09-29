import { NONE, fold, isPresent, result, ring, tailOf } from '../values/index.js';
/** `variance(src, len, sample)`: the squared deviation over the lookback, from bar `len - 1`. */
export function varianceStep(state, key, value, len, sample) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null)
        return NONE;
    const divisor = sample ? len - 1 : len;
    if (!lookback.complete() || divisor <= 0)
        return NONE;
    const mean = lookback.mean();
    if (!isPresent(mean))
        return NONE;
    let squares = 0;
    // Oldest bar first, the order of `lookback.ts`.
    for (let back = len - 1; back >= 0; back -= 1) {
        const deviation = lookback.at(back) - mean;
        squares += deviation * deviation;
    }
    return result(squares / divisor);
}
/** `variance(src, len, sample)` as a tail. */
export function varianceTail(len, sample = false) {
    return tailOf((state, value) => varianceStep(state, 'q', value, len, sample));
}
/** `variance(src, len, sample)` over a whole series. */
export function variance(src, len, sample = false) {
    return fold(varianceTail(len, sample), src);
}
/** `stdev(src, len, sample)`: the square root of the same, from bar `len - 1`. */
export function stdevStep(state, key, value, len, sample) {
    const squared = varianceStep(state, key, value, len, sample);
    if (!isPresent(squared) || squared < 0)
        return NONE;
    return result(Math.sqrt(squared));
}
/** `stdev(src, len, sample)` as a tail. */
export function stdevTail(len, sample = false) {
    return tailOf((state, value) => stdevStep(state, 'q', value, len, sample));
}
/** `stdev(src, len, sample)` over a whole series. */
export function stdev(src, len, sample = false) {
    return fold(stdevTail(len, sample), src);
}
/**
 * The mean absolute deviation from the lookback's mean.
 *
 * Not a call of its own in `stdlib.md`, and here because `cci` is defined
 * against it rather than against `stdev`: the 0.015 constant in that study is
 * calibrated for this quantity, and substituting a standard deviation changes
 * every reading.
 */
export function meanDeviationStep(state, key, value, len) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || !lookback.complete())
        return NONE;
    const mean = lookback.mean();
    if (!isPresent(mean))
        return NONE;
    let total = 0;
    for (let back = len - 1; back >= 0; back -= 1) {
        total += Math.abs(lookback.at(back) - mean);
    }
    return result(total / len);
}
/** The mean absolute deviation as a tail. */
export function meanDeviationTail(len) {
    return tailOf((state, value) => meanDeviationStep(state, 'q', value, len));
}
/** The mean absolute deviation over a whole series. */
export function meanDeviation(src, len) {
    return fold(meanDeviationTail(len), src);
}
//# sourceMappingURL=deviation.js.map