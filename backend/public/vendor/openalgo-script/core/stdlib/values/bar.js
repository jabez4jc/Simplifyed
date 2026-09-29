import { NONE, isPresent, result } from './value.js';
/**
 * `(high + low) / 2`, the bar's midpoint.
 *
 * It takes the two extremes rather than the whole bar, because the studies
 * built on a range hold those two and the close before them rather than a bar.
 */
export function hl2(bar) {
    if (!isPresent(bar.high) || !isPresent(bar.low))
        return NONE;
    return result((bar.high + bar.low) / 2);
}
/** `(high + low + close) / 3`, the typical price. */
export function hlc3(bar) {
    if (!isPresent(bar.high) || !isPresent(bar.low) || !isPresent(bar.close))
        return NONE;
    return result((bar.high + bar.low + bar.close) / 3);
}
/** `(open + high + low + close) / 4`, the average price. */
export function ohlc4(bar) {
    if (!isPresent(bar.open) || !isPresent(bar.high))
        return NONE;
    if (!isPresent(bar.low) || !isPresent(bar.close))
        return NONE;
    return result((bar.open + bar.high + bar.low + bar.close) / 4);
}
/** `(high + low + close + close) / 4`, the close-weighted average price. */
export function hlcc4(bar) {
    if (!isPresent(bar.high) || !isPresent(bar.low) || !isPresent(bar.close))
        return NONE;
    return result((bar.high + bar.low + bar.close + bar.close) / 4);
}
//# sourceMappingURL=bar.js.map