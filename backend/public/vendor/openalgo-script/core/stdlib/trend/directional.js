import { NONE, fold, held, isPresent, result, ring, tailOf } from '../values/index.js';
import { rmaStep } from '../averages/index.js';
import { extremeStep } from '../series/index.js';
import { gapOf, trueRangeOf } from '../volatility/index.js';
/**
 * `adx(diLen, adxLen)`: `[adx, plusDI, minusDI]`, elements 1 and 2 from bar
 * `diLen` and element 0 from bar `diLen + adxLen - 1`.
 *
 * Directional movement is the part of this bar's range that lies outside the
 * previous bar's, on whichever side is larger. It needs the bar before it, so
 * the smoothing's lookback is bars 1 to `diLen` and the first reading is at bar
 * `diLen`. The true range in the denominator uses the gap-aware form for the
 * same reason, so all three smoothed quantities cover the same bars: seeding
 * one of them a bar earlier than the other two would bias every reading after
 * it while still looking entirely plausible.
 *
 * The previous bar's two extremes are held in the region, because they are the
 * arithmetic's own history. The previous close is not: it arrives with the gap,
 * for the reason `range.ts` sets out.
 */
export function adxStep(state, key, gap, diLen, adxLen) {
    const highKey = `${key}h`;
    const lowKey = `${key}l`;
    const seenKey = `${key}k`;
    const beforeHigh = held(state, highKey);
    const beforeLow = held(state, lowKey);
    const started = state[seenKey] === true;
    state[seenKey] = true;
    state[highKey] = gap.high;
    state[lowKey] = gap.low;
    let upMove = NONE;
    let downMove = NONE;
    if (started &&
        isPresent(gap.high) &&
        isPresent(gap.low) &&
        isPresent(beforeHigh) &&
        isPresent(beforeLow)) {
        const up = gap.high - beforeHigh;
        const down = beforeLow - gap.low;
        upMove = up > down && up > 0 ? result(up) : 0;
        downMove = down > up && down > 0 ? result(down) : 0;
    }
    const trueRange = rmaStep(state, `${key}r`, trueRangeOf(gap, false), diLen);
    const rise = rmaStep(state, `${key}u`, upMove, diLen);
    const fall = rmaStep(state, `${key}d`, downMove, diLen);
    let plus = NONE;
    let minus = NONE;
    if (isPresent(trueRange) && trueRange !== 0) {
        if (isPresent(rise))
            plus = result((rise / trueRange) * 100);
        if (isPresent(fall))
            minus = result((fall / trueRange) * 100);
    }
    let spread = NONE;
    if (isPresent(plus) && isPresent(minus)) {
        const total = plus + minus;
        spread = total > 0 ? result((Math.abs(plus - minus) / total) * 100) : 0;
    }
    return [rmaStep(state, `${key}x`, spread, adxLen), plus, minus];
}
/** `adx(diLen, adxLen)` as a tail. */
export function adxTail(diLen = 14, adxLen = 14) {
    return tailOf((state, bar) => adxStep(state, '', gapOf(state, 'g', bar), diLen, adxLen));
}
/** `adx(diLen, adxLen)` over a run of bars. */
export function adx(bars, diLen = 14, adxLen = 14) {
    return fold(adxTail(diLen, adxLen), bars);
}
/**
 * `aroon(len)`: `[up, down]`, both from bar `len`.
 *
 * How recently the lookback's high and low were set, as a percentage: 100 when it
 * was this bar, 0 when it was `len` bars ago. The lookback is `len + 1` bars
 * wide, because a reading of 0 has to be reachable and an extreme `len` bars
 * back has to still be inside the lookback for that. That extra bar is where the
 * declared warmup of bar `len` rather than bar `len - 1` comes from.
 */
export function aroonStep(state, key, high, low, len) {
    const wide = len === null ? null : len + 1;
    const highAge = extremeStep(state, `${key}h`, high, wide, true, true);
    const lowAge = extremeStep(state, `${key}l`, low, wide, false, true);
    if (len === null)
        return [NONE, NONE];
    const up = isPresent(highAge) ? result((100 * (len - highAge)) / len) : NONE;
    const down = isPresent(lowAge) ? result((100 * (len - lowAge)) / len) : NONE;
    return [up, down];
}
/** `aroon(len)` as a tail. */
export function aroonTail(len = 14) {
    return tailOf((state, bar) => aroonStep(state, '', bar.high, bar.low, len));
}
/** `aroon(len)` over a run of bars. */
export function aroon(bars, len = 14) {
    return fold(aroonTail(len), bars);
}
/**
 * `ichimoku(convLen, baseLen, spanLen)`: `[conversion, base, spanA, spanB,
 * lagging]`, at bars `convLen - 1`, `baseLen - 1`, `baseLen - 1`,
 * `spanLen - 1` and `baseLen - 1`.
 *
 * Each of the first four lines is the midpoint of a lookback's outright high and
 * low, over a different length. **The spans are returned undisplaced, at the
 * bar they are computed on**, per `stdlib.md` section 4: a study draws them
 * forward with the plot's `offset` argument, because a series that has already
 * been shifted cannot be compared with anything else in the script without
 * shifting it back.
 *
 * The lagging line is this bar's close, and it is drawn backward by the same
 * plot argument. It is absent until bar `baseLen - 1`, which is the warmup the
 * specification declares for it, and which is the first bar there is enough
 * history for the displacement to land on.
 */
export function ichimokuStep(state, key, bar, convLen, baseLen, spanLen) {
    const near = midpointStep(state, `${key}c`, bar, convLen);
    const middle = midpointStep(state, `${key}b`, bar, baseLen);
    const leading = isPresent(near) && isPresent(middle) ? result((near + middle) / 2) : NONE;
    const behind = midpointStep(state, `${key}s`, bar, spanLen);
    const closes = ring(state, `${key}g`, baseLen);
    closes.push(bar.close);
    const lagging = closes.filled() ? closes.at(0) : NONE;
    return [near, middle, leading, behind, lagging];
}
/** `ichimoku(convLen, baseLen, spanLen)` as a tail. */
export function ichimokuTail(convLen = 9, baseLen = 26, spanLen = 52) {
    return tailOf((state, bar) => ichimokuStep(state, '', bar, convLen, baseLen, spanLen));
}
/** `ichimoku(convLen, baseLen, spanLen)` over a run of bars. */
export function ichimoku(bars, convLen = 9, baseLen = 26, spanLen = 52) {
    return fold(ichimokuTail(convLen, baseLen, spanLen), bars);
}
/** The midpoint of a lookback's outright high and low. */
function midpointStep(state, key, bar, len) {
    const highs = ring(state, `${key}h`, len);
    const lows = ring(state, `${key}l`, len);
    highs.push(bar.high);
    lows.push(bar.low);
    if (len === null || !highs.complete() || !lows.complete())
        return NONE;
    let top = highs.at(len - 1);
    let bottom = lows.at(len - 1);
    for (let back = len - 2; back >= 0; back -= 1) {
        const high = highs.at(back);
        const low = lows.at(back);
        if (high > top)
            top = high;
        if (low < bottom)
            bottom = low;
    }
    return result((top + bottom) / 2);
}
//# sourceMappingURL=directional.js.map