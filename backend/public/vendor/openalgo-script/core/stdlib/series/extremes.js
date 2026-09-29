import { NONE, fold, result, ring, tailOf } from '../values/index.js';
/** Where the extreme sits in a complete lookback, as bars back from this one. */
function extremeBack(read, len, wantHigh) {
    let best = read(len - 1);
    let bestBack = len - 1;
    // Oldest first, so an equal value later in the lookback replaces the earlier
    // one and the answer is the most recent bar that set the extreme.
    for (let position = 1; position < len; position += 1) {
        const back = len - 1 - position;
        const value = read(back);
        if (wantHigh ? value >= best : value <= best) {
            best = value;
            bestBack = back;
        }
    }
    return bestBack;
}
/** `highest`, `lowest` and the two that report where the extreme was set. */
export function extremeStep(state, key, value, len, wantHigh, asBars) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || !lookback.complete())
        return NONE;
    const back = extremeBack((k) => lookback.at(k), len, wantHigh);
    return asBars ? back : result(lookback.at(back));
}
function extremeTail(len, wantHigh, asBars) {
    return tailOf((state, value) => extremeStep(state, 'q', value, len, wantHigh, asBars));
}
/** `highest(src, len)`: the largest value in the last `len` bars, from bar `len - 1`. */
export function highestTail(len) {
    return extremeTail(len, true, false);
}
/** `highest(src, len)` over a whole series. */
export function highest(src, len) {
    return fold(highestTail(len), src);
}
/** `lowest(src, len)`: the smallest value in the last `len` bars, from bar `len - 1`. */
export function lowestTail(len) {
    return extremeTail(len, false, false);
}
/** `lowest(src, len)` over a whole series. */
export function lowest(src, len) {
    return fold(lowestTail(len), src);
}
/** `highestBars(src, len)`: how many bars back the lookback's high was set. */
export function highestBarsTail(len) {
    return extremeTail(len, true, true);
}
/** `highestBars(src, len)` over a whole series. */
export function highestBars(src, len) {
    return fold(highestBarsTail(len), src);
}
/** `lowestBars(src, len)`: how many bars back the lookback's low was set. */
export function lowestBarsTail(len) {
    return extremeTail(len, false, true);
}
/** `lowestBars(src, len)` over a whole series. */
export function lowestBars(src, len) {
    return fold(lowestBarsTail(len), src);
}
//# sourceMappingURL=extremes.js.map