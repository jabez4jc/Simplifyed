import { NONE, fold, isPresent, result, ring, tailOf } from '../values/index.js';
/** `pivotHigh` and `pivotLow`, answered on the bar the pivot becomes knowable. */
export function pivotStep(state, key, value, left, right, wantHigh) {
    const span = left === null || right === null ? null : left + right + 1;
    const lookback = ring(state, key, span);
    lookback.push(value);
    if (span === null || right === null || !lookback.filled())
        return NONE;
    const candidate = lookback.at(right);
    if (!isPresent(candidate))
        return NONE;
    for (let back = span - 1; back >= 0; back -= 1) {
        if (back === right)
            continue;
        const other = lookback.at(back);
        if (!isPresent(other))
            return NONE;
        if (wantHigh ? other >= candidate : other <= candidate)
            return NONE;
    }
    return result(candidate);
}
function pivotTail(left, right, wantHigh) {
    return tailOf((state, value) => pivotStep(state, 'q', value, left, right, wantHigh));
}
/** `pivotHigh(src, left, right)`: the value of a local high, from bar `left + right`. */
export function pivotHighTail(left, right) {
    return pivotTail(left, right, true);
}
/** `pivotHigh(src, left, right)` over a whole series. */
export function pivotHigh(src, left, right) {
    return fold(pivotHighTail(left, right), src);
}
/** `pivotLow(src, left, right)`: the value of a local low, from bar `left + right`. */
export function pivotLowTail(left, right) {
    return pivotTail(left, right, false);
}
/** `pivotLow(src, left, right)` over a whole series. */
export function pivotLow(src, left, right) {
    return fold(pivotLowTail(left, right), src);
}
//# sourceMappingURL=pivots.js.map