import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { emaStep, smaStep } from '../averages/index.js';
import { changeStep, changeTail, historyStep, sumStep } from '../series/index.js';
/** `mom(src, len)`: `src - src[len]`, from bar `len`. */
export function momTail(len = 10) {
    return changeTail(len);
}
/** `mom(src, len)` over a whole series. */
export function mom(src, len = 10) {
    return fold(momTail(len), src);
}
/** `roc(src, len)`: the same change as a percentage of the older value, from bar `len`. */
export function rocStep(state, key, value, len) {
    const then = historyStep(state, `${key}h`, value, len);
    const delta = changeStep(state, `${key}c`, value, len);
    if (!isPresent(then) || !isPresent(delta) || then === 0)
        return NONE;
    return result((100 * delta) / then);
}
/** `roc(src, len)` as a tail. */
export function rocTail(len = 9) {
    return tailOf((state, value) => rocStep(state, '', value, len));
}
/** `roc(src, len)` over a whole series. */
export function roc(src, len = 9) {
    return fold(rocTail(len), src);
}
/**
 * `cmo(src, len)`: up sum less down sum over their total, -100 to 100, from bar
 * `len`.
 *
 * Unsmoothed, which is the whole point of it: the sums are taken over the
 * lookback outright rather than through an average, so a turn shows on the bar it
 * happens.
 */
export function cmoStep(state, key, value, len) {
    const delta = changeStep(state, `${key}c`, value, 1);
    const up = isPresent(delta) ? result(Math.max(delta, 0)) : NONE;
    const down = isPresent(delta) ? result(Math.max(-delta, 0)) : NONE;
    const rise = sumStep(state, `${key}u`, up, len);
    const fall = sumStep(state, `${key}d`, down, len);
    if (!isPresent(rise) || !isPresent(fall))
        return NONE;
    const total = rise + fall;
    if (total === 0)
        return NONE;
    return result((100 * (rise - fall)) / total);
}
/** `cmo(src, len)` as a tail. */
export function cmoTail(len = 9) {
    return tailOf((state, value) => cmoStep(state, '', value, len));
}
/** `cmo(src, len)` over a whole series. */
export function cmo(src, len = 9) {
    return fold(cmoTail(len), src);
}
/**
 * `trix(src, len)`: the rate of change of a triple exponential mean, from bar
 * `3 * len - 2`.
 *
 * `stdlib.md` section 5 says rate of change, so this is the percentage change
 * of the smoothed series over one bar. The other reading in circulation takes
 * the change of the logarithm of the average instead; it is a different number
 * and it is not what the entry describes.
 */
export function trixStep(state, key, value, len) {
    const once = emaStep(state, `${key}a`, value, len);
    const twice = emaStep(state, `${key}b`, once, len);
    const smoothed = emaStep(state, `${key}c`, twice, len);
    const before = historyStep(state, `${key}h`, smoothed, 1);
    if (!isPresent(smoothed) || !isPresent(before) || before === 0)
        return NONE;
    return result((100 * (smoothed - before)) / before);
}
/** `trix(src, len)` as a tail. */
export function trixTail(len = 18) {
    return tailOf((state, value) => trixStep(state, '', value, len));
}
/** `trix(src, len)` over a whole series. */
export function trix(src, len = 18) {
    return fold(trixTail(len), src);
}
/**
 * `tsi(src, longLen, shortLen)`: double smoothed momentum, from bar
 * `longLen + shortLen - 1`.
 *
 * The change smoothed twice, over the size of the change smoothed the same way
 * twice, so the result is a direction rather than a magnitude and the noise
 * `mom` carries is gone.
 */
export function tsiStep(state, key, value, longLen, shortLen) {
    const delta = changeStep(state, `${key}c`, value, 1);
    const size = isPresent(delta) ? result(Math.abs(delta)) : NONE;
    const direction = emaStep(state, `${key}n`, emaStep(state, `${key}m`, delta, longLen), shortLen);
    const magnitude = emaStep(state, `${key}z`, emaStep(state, `${key}y`, size, longLen), shortLen);
    if (!isPresent(direction) || !isPresent(magnitude) || magnitude === 0)
        return NONE;
    return result((100 * direction) / magnitude);
}
/** `tsi(src, longLen, shortLen)` as a tail. */
export function tsiTail(longLen = 25, shortLen = 13) {
    return tailOf((state, value) => tsiStep(state, '', value, longLen, shortLen));
}
/** `tsi(src, longLen, shortLen)` over a whole series. */
export function tsi(src, longLen = 25, shortLen = 13) {
    return fold(tsiTail(longLen, shortLen), src);
}
/**
 * `dpo(src, len)`: price with its displaced mean removed, from bar
 * `len + floor(len / 2)`.
 *
 * The mean is read `floor(len / 2) + 1` bars back rather than at this bar,
 * which is what "displaced" means here and what the declared warmup requires:
 * the average's own first value at bar `len - 1`, plus the displacement, is
 * exactly `len + floor(len / 2)`. Removing an undisplaced mean would be a
 * different study with a warmup of `len - 1`.
 */
export function dpoStep(state, key, value, len) {
    const average = smaStep(state, `${key}q`, value, len);
    const back = len === null ? null : Math.floor(len / 2) + 1;
    const mean = historyStep(state, `${key}h`, average, back);
    if (!isPresent(value) || !isPresent(mean))
        return NONE;
    return result(value - mean);
}
/** `dpo(src, len)` as a tail. */
export function dpoTail(len = 21) {
    return tailOf((state, value) => dpoStep(state, '', value, len));
}
/** `dpo(src, len)` over a whole series. */
export function dpo(src, len = 21) {
    return fold(dpoTail(len), src);
}
//# sourceMappingURL=rates.js.map