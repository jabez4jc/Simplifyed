import { NONE, fold, isPresent, result, ring, tailOf } from '../values/index.js';
/** `sma(src, len)`: the arithmetic mean of the last `len` values, from bar `len - 1`. */
export function smaStep(state, key, value, len) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    return lookback.mean();
}
/** `sma(src, len)` as a tail. */
export function smaTail(len) {
    return tailOf((state, value) => smaStep(state, 'q', value, len));
}
/** `sma(src, len)` over a whole series. */
export function sma(src, len) {
    return fold(smaTail(len), src);
}
/**
 * `wma(src, len)`: linearly weighted, the newest value weighted `len`, from bar
 * `len - 1`.
 *
 * `stdlib.md` section 4 fixes the weights and not the order they are summed in,
 * so the order is this library's own and is the one stated in `lookback.ts`:
 * oldest bar first, which is weight 1 first and weight `len` last.
 */
export function wmaStep(state, key, value, len) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || !lookback.complete())
        return NONE;
    const divisor = (len * (len + 1)) / 2;
    let total = 0;
    for (let back = len - 1; back >= 0; back -= 1) {
        total += lookback.at(back) * (len - back);
    }
    return result(total / divisor);
}
/** `wma(src, len)` as a tail. */
export function wmaTail(len) {
    return tailOf((state, value) => wmaStep(state, 'w', value, len));
}
/** `wma(src, len)` over a whole series. */
export function wma(src, len) {
    return fold(wmaTail(len), src);
}
/** `swma(src)`: the fixed four bar symmetric mean, weights 1, 2, 2, 1 over 6, from bar 3. */
export function swmaStep(state, key, value) {
    const lookback = ring(state, key, 4);
    lookback.push(value);
    if (!lookback.complete())
        return NONE;
    const oldest = lookback.at(3);
    const second = lookback.at(2);
    const third = lookback.at(1);
    const newest = lookback.at(0);
    return result((oldest + 2 * second + 2 * third + newest) / 6);
}
/** `swma(src)` as a tail. */
export function swmaTail() {
    return tailOf((state, value) => swmaStep(state, 'q', value));
}
/** `swma(src)` over a whole series. */
export function swma(src) {
    return fold(swmaTail(), src);
}
/**
 * `vwma(src, len)`: the mean weighted by each bar's volume, from bar `len - 1`.
 *
 * The total of `src * volume` over the total of `volume`, which is what "mean
 * weighted by volume" says. Dividing two means by `len` first and then dividing
 * one by the other is the same quantity with two extra roundings in it, and
 * this is the arrangement without them.
 */
export function vwmaStep(state, key, input, len) {
    const flow = ring(state, `${key}f`, len);
    const quantity = ring(state, `${key}v`, len);
    const product = isPresent(input.src) && isPresent(input.volume) ? result(input.src * input.volume) : NONE;
    flow.push(product);
    quantity.push(input.volume);
    const numerator = flow.sum();
    const denominator = quantity.sum();
    if (!isPresent(numerator) || !isPresent(denominator) || denominator === 0)
        return NONE;
    return result(numerator / denominator);
}
/** `vwma(src, len)` as a tail. */
export function vwmaTail(len) {
    return tailOf((state, input) => vwmaStep(state, 'q', input, len));
}
/** `vwma(src, len)` over a whole series. */
export function vwma(src, volume, len) {
    return fold(vwmaTail(len), src.map((value, index) => ({ src: value, volume: volume[index] ?? NONE })));
}
//# sourceMappingURL=simple.js.map