import { NONE, fold, isLength, isPresent, result, ring, tailOf, } from '../values/index.js';
import { roundHalfAway } from '../maths/index.js';
import { wmaStep } from './simple.js';
import { gaussianWeights } from './gaussian.js';
/**
 * `hma(src, len)`: from bar `len + round(sqrt(len)) - 2`.
 *
 * `wma` of twice the half length average less the full length one, smoothed
 * again over the square root of the length.
 *
 * **The half length is not stated.** `stdlib.md` section 4 fixes the outer
 * length as `round(sqrt(len))`, which the declared warmup confirms, and says
 * nothing about the inner one. `floor(len / 2)` is used here, held at a minimum
 * of 1 so a length of 1 or 2 still has a lookback, and the declared warmup holds
 * for any inner length at or below `len`, so nothing in the warmup column
 * settles it. This is recorded as a gap rather than presented as a reading.
 */
export function hmaStep(state, key, value, len) {
    const half = len === null ? null : Math.max(1, Math.floor(len / 2));
    const outer = len === null ? null : Math.max(1, roundHalfAway(Math.sqrt(len)));
    const near = wmaStep(state, `${key}f`, value, half);
    const far = wmaStep(state, `${key}s`, value, len);
    const raw = isPresent(near) && isPresent(far) ? result(2 * near - far) : NONE;
    return wmaStep(state, `${key}o`, raw, outer);
}
/** `hma(src, len)` as a tail. */
export function hmaTail(len) {
    return tailOf((state, value) => hmaStep(state, '', value, len));
}
/** `hma(src, len)` over a whole series. */
export function hma(src, len) {
    return fold(hmaTail(len), src);
}
/**
 * `alma(src, len, offset, sigma)`: the Gaussian weighted mean, from bar `len - 1`.
 *
 * `offset` slides the kernel's peak between lag and smoothness and `sigma` sets
 * how sharply it falls away.
 *
 * A bounded pure cache holds immutable coefficients keyed by the current
 * parameters. Source observations remain exclusively in the copyable region.
 */
export function almaStep(state, key, value, len, offset, sigma) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || offset === null || sigma === null)
        return NONE;
    if (!lookback.complete())
        return NONE;
    if (!(sigma > 0) || !isLength(len))
        return NONE;
    const kernel = gaussianWeights(len, offset, sigma);
    if (kernel === null)
        return NONE;
    const { weights, norm } = kernel;
    let total = 0;
    for (let position = 0; position < len; position += 1) {
        total += lookback.at(len - 1 - position) * weights[position];
    }
    return result(total / norm);
}
/** `alma(src, len, offset, sigma)` as a tail. */
export function almaTail(len, offset = 0.85, sigma = 6) {
    return tailOf((state, value) => almaStep(state, 'q', value, len, offset, sigma));
}
/** `alma(src, len, offset, sigma)` over a whole series. */
export function alma(src, len, offset = 0.85, sigma = 6) {
    return fold(almaTail(len, offset, sigma), src);
}
/**
 * `linreg(src, len, offset)`: the least squares line through the last `len`
 * points, read `offset` bars back along it, from bar `len - 1`.
 *
 * `x` runs 0 at the oldest bar of the lookback to `len - 1` at the current one,
 * so the value at the current bar is `intercept + slope * (len - 1)` and a
 * positive `offset` steps back down the line without refitting it.
 *
 * A length of 1 has no line through it: the normal equations are singular, and
 * the answer is absence rather than the single point, because a line fitted to
 * one point is not a fit.
 */
export function linregStep(state, key, value, len, offset) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || offset === null || !lookback.complete())
        return NONE;
    // The x values are the same lookback every bar, so their sums are constants.
    const sumX = ((len - 1) * len) / 2;
    const sumXSquared = ((len - 1) * len * (2 * len - 1)) / 6;
    const divisor = len * sumXSquared - sumX * sumX;
    if (divisor === 0)
        return NONE;
    let sumY = 0;
    let sumXY = 0;
    for (let position = 0; position < len; position += 1) {
        const y = lookback.at(len - 1 - position);
        sumY += y;
        sumXY += y * position;
    }
    const slope = (len * sumXY - sumX * sumY) / divisor;
    const intercept = (sumY - slope * sumX) / len;
    return result(intercept + slope * (len - 1 - offset));
}
/** `linreg(src, len, offset)` as a tail. */
export function linregTail(len, offset = 0) {
    return tailOf((state, value) => linregStep(state, 'q', value, len, offset));
}
/** `linreg(src, len, offset)` over a whole series. */
export function linreg(src, len, offset = 0) {
    return fold(linregTail(len, offset), src);
}
//# sourceMappingURL=shaped.js.map