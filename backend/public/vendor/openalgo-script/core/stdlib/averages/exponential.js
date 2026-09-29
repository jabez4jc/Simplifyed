import { NONE, fold, isPresent, result, smoothed, tailOf } from '../values/index.js';
/** `ema(src, len)`: exponential mean, weight `2 / (len + 1)`, from bar `len - 1`. */
export function emaStep(state, key, value, len) {
    const weight = len === null ? 0 : 2 / (len + 1);
    const rest = 1 - weight;
    return smoothed(state, key, len, value, (previous, next) => next * weight + previous * rest);
}
/** `ema(src, len)` as a tail. */
export function emaTail(len) {
    return tailOf((state, value) => emaStep(state, 'e', value, len));
}
/** `ema(src, len)` over a whole series. */
export function ema(src, len) {
    return fold(emaTail(len), src);
}
/** `rma(src, len)`: the smoothing the classic oscillators use, from bar `len - 1`. */
export function rmaStep(state, key, value, len) {
    const span = len ?? 1;
    return smoothed(state, key, len, value, (previous, next) => (previous * (span - 1) + next) / span);
}
/** `rma(src, len)` as a tail. */
export function rmaTail(len) {
    return tailOf((state, value) => rmaStep(state, 'r', value, len));
}
/** `rma(src, len)` over a whole series. */
export function rma(src, len) {
    return fold(rmaTail(len), src);
}
/**
 * `dema(src, len)`: `2 * ema - ema(ema)`, from bar `2 * len - 2`.
 *
 * The second average is fed the first one's output, absences and all, so it
 * seeds on the first `len` values the first average produced. That is where the
 * declared warmup comes from rather than being asserted alongside it.
 */
export function demaStep(state, key, value, len) {
    const once = emaStep(state, `${key}a`, value, len);
    const twice = emaStep(state, `${key}b`, once, len);
    if (!isPresent(once) || !isPresent(twice))
        return NONE;
    return result(2 * once - twice);
}
/** `dema(src, len)` as a tail. */
export function demaTail(len) {
    return tailOf((state, value) => demaStep(state, 'e', value, len));
}
/** `dema(src, len)` over a whole series. */
export function dema(src, len) {
    return fold(demaTail(len), src);
}
/** `tema(src, len)`: `3 * e1 - 3 * e2 + e3`, from bar `3 * len - 3`. */
export function temaStep(state, key, value, len) {
    const once = emaStep(state, `${key}a`, value, len);
    const twice = emaStep(state, `${key}b`, once, len);
    const thrice = emaStep(state, `${key}c`, twice, len);
    if (!isPresent(once) || !isPresent(twice) || !isPresent(thrice))
        return NONE;
    // Left to right, as written: 3 * e1, less 3 * e2, plus e3.
    return result(3 * once - 3 * twice + thrice);
}
/** `tema(src, len)` as a tail. */
export function temaTail(len) {
    return tailOf((state, value) => temaStep(state, 'e', value, len));
}
/** `tema(src, len)` over a whole series. */
export function tema(src, len) {
    return fold(temaTail(len), src);
}
//# sourceMappingURL=exponential.js.map