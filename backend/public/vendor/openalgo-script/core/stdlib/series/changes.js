import { NONE, fold, isPresent, result, ring, tailOf } from '../values/index.js';
/** `change(src, len)`: `src - src[len]`, from bar `len`. */
export function changeStep(state, key, value, len) {
    const lookback = ring(state, key, len === null ? null : len + 1);
    lookback.push(value);
    if (len === null || !lookback.filled())
        return NONE;
    const now = lookback.at(0);
    const then = lookback.at(len);
    if (!isPresent(now) || !isPresent(then))
        return NONE;
    return result(now - then);
}
/** `change(src, len)` as a tail. */
export function changeTail(len = 1) {
    return tailOf((state, value) => changeStep(state, 'c', value, len));
}
/** `change(src, len)` over a whole series. */
export function change(src, len = 1) {
    return fold(changeTail(len), src);
}
/** `history(src, n)`: `src` as it stood `n` bars ago, from bar `n`. */
export function historyStep(state, key, value, back) {
    const lookback = ring(state, key, back === null ? null : back + 1);
    lookback.push(value);
    return back !== null && lookback.filled() ? lookback.at(back) : NONE;
}
/** `history(src, n)` as a tail. */
export function historyTail(back) {
    return tailOf((state, value) => historyStep(state, 'h', value, back));
}
/** `history(src, n)` over a whole series. */
export function history(src, back) {
    return fold(historyTail(back), src);
}
/** `rising` and `falling`: every one of the last `len` changes went one way. */
export function runStep(state, key, value, len, wantUp) {
    const lookback = ring(state, key, len === null ? null : len + 1);
    lookback.push(value);
    if (len === null || !lookback.filled())
        return null;
    // Oldest first, comparing each bar with the one before it.
    for (let back = len - 1; back >= 0; back -= 1) {
        const now = lookback.at(back);
        const before = lookback.at(back + 1);
        if (!isPresent(now) || !isPresent(before))
            return null;
        if (wantUp ? !(now > before) : !(now < before))
            return false;
    }
    return true;
}
/** `rising(src, len)`: true when each of the last `len` changes was positive, from bar `len`. */
export function risingTail(len) {
    return tailOf((state, value) => runStep(state, 'q', value, len, true));
}
/** `rising(src, len)` over a whole series. */
export function rising(src, len) {
    return fold(risingTail(len), src);
}
/** `falling(src, len)`: true when each of the last `len` changes was negative, from bar `len`. */
export function fallingTail(len) {
    return tailOf((state, value) => runStep(state, 'q', value, len, false));
}
/** `falling(src, len)` over a whole series. */
export function falling(src, len) {
    return fold(fallingTail(len), src);
}
/**
 * The crossing test, which keeps the two series apart rather than subtracting.
 *
 * A difference would round, and the whole test turns on whether one series was
 * at or below the other, which is the one place a rounded zero would change the
 * answer.
 */
export function crossStep(state, key, pair, direction) {
    const left = ring(state, `${key}a`, 2);
    const right = ring(state, `${key}b`, 2);
    left.push(pair.a);
    right.push(pair.b);
    if (!left.filled())
        return null;
    const nowA = left.at(0);
    const nowB = right.at(0);
    const beforeA = left.at(1);
    const beforeB = right.at(1);
    if (!isPresent(nowA) || !isPresent(nowB))
        return null;
    if (!isPresent(beforeA) || !isPresent(beforeB))
        return null;
    const up = beforeA <= beforeB && nowA > nowB;
    const down = beforeA >= beforeB && nowA < nowB;
    if (direction === 'up')
        return up;
    if (direction === 'down')
        return down;
    return up || down;
}
function crossTail(direction) {
    return tailOf((state, pair) => crossStep(state, '', pair, direction));
}
/** `crossUp(a, b)`: `a` was at or below `b` and is now above, from bar 1. */
export function crossUpTail() {
    return crossTail('up');
}
/** `crossDown(a, b)`: `a` was at or above `b` and is now below, from bar 1. */
export function crossDownTail() {
    return crossTail('down');
}
/** `cross(a, b)`: either direction, from bar 1. */
export function crossEitherTail() {
    return crossTail('either');
}
function pairs(a, b) {
    return a.map((value, index) => ({ a: value, b: b[index] ?? NONE }));
}
/** `crossUp(a, b)` over whole series. */
export function crossUp(a, b) {
    return fold(crossUpTail(), pairs(a, b));
}
/** `crossDown(a, b)` over whole series. */
export function crossDown(a, b) {
    return fold(crossDownTail(), pairs(a, b));
}
/** `cross(a, b)` over whole series. */
export function cross(a, b) {
    return fold(crossEitherTail(), pairs(a, b));
}
//# sourceMappingURL=changes.js.map