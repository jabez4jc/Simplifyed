import { NONE, fold, result, ring, tailOf } from '../values/index.js';
/** The lookback's values, oldest first, as plain numbers. */
function ordered(read, len) {
    const values = [];
    for (let back = len - 1; back >= 0; back -= 1)
        values.push(read(back));
    return values;
}
/**
 * `percentile(src, len, p)`: the value at percentile `p` of the lookback,
 * linearly interpolated, from bar `len - 1`.
 */
export function percentileStep(state, key, value, len, p) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || p === null || !lookback.complete())
        return NONE;
    if (!(p >= 0 && p <= 100))
        return NONE;
    const sorted = ordered((back) => lookback.at(back), len).sort((a, b) => a - b);
    const rank = (p / 100) * (len - 1);
    const below = Math.floor(rank);
    const above = below + 1;
    const low = sorted[below];
    if (above >= len)
        return result(low);
    const high = sorted[above];
    return result(low + (rank - below) * (high - low));
}
/** `percentile(src, len, p)` as a tail. */
export function percentileTail(len, p) {
    return tailOf((state, value) => percentileStep(state, 'q', value, len, p));
}
/** `percentile(src, len, p)` over a whole series. */
export function percentile(src, len, p) {
    return fold(percentileTail(len, p), src);
}
/**
 * `median(src, len)`: the middle value of the lookback, from bar `len - 1`.
 *
 * The 50th percentile by the same interpolation, so an even length lookback is
 * the mean of its two middles rather than one of them chosen by a rule nobody
 * remembers.
 */
export function medianTail(len) {
    return percentileTail(len, 50);
}
/** `median(src, len)` over a whole series. */
export function median(src, len) {
    return fold(medianTail(len), src);
}
/**
 * `percentRank(src, len)`: what percentage of the lookback this bar's value
 * exceeds, from bar `len - 1`.
 *
 * The lookback is the last `len` bars including this one, which is what the
 * declared warmup of bar `len - 1` says: a lookback of the `len` bars before this
 * one would not have its first answer until bar `len`. This bar is therefore
 * one of the values counted, so the reading runs from `100 / len` to 100 rather
 * than from 0.
 */
export function percentRankStep(state, key, value, len) {
    const lookback = ring(state, key, len);
    lookback.push(value);
    if (len === null || !lookback.complete())
        return NONE;
    const current = lookback.at(0);
    let counted = 0;
    for (let back = len - 1; back >= 0; back -= 1) {
        if (lookback.at(back) <= current)
            counted += 1;
    }
    return result((counted * 100) / len);
}
/** `percentRank(src, len)` as a tail. */
export function percentRankTail(len) {
    return tailOf((state, value) => percentRankStep(state, 'q', value, len));
}
/** `percentRank(src, len)` over a whole series. */
export function percentRank(src, len) {
    return fold(percentRankTail(len), src);
}
function moments(a, b, len) {
    let sumA = 0;
    let sumB = 0;
    for (let index = 0; index < len; index += 1) {
        sumA += a[index];
        sumB += b[index];
    }
    const meanA = sumA / len;
    const meanB = sumB / len;
    let cross = 0;
    let squaresA = 0;
    let squaresB = 0;
    for (let index = 0; index < len; index += 1) {
        const deviationA = a[index] - meanA;
        const deviationB = b[index] - meanB;
        cross += deviationA * deviationB;
        squaresA += deviationA * deviationA;
        squaresB += deviationB * deviationB;
    }
    return { covariance: cross / len, varianceA: squaresA / len, varianceB: squaresB / len };
}
function jointStep(state, key, pair, len, want) {
    const left = ring(state, `${key}a`, len);
    const right = ring(state, `${key}b`, len);
    left.push(pair.a);
    right.push(pair.b);
    if (len === null || !left.complete() || !right.complete())
        return NONE;
    const a = ordered((back) => left.at(back), len);
    const b = ordered((back) => right.at(back), len);
    const m = moments(a, b, len);
    if (want === 'covariance')
        return result(m.covariance);
    if (!Number.isFinite(m.varianceA) || !Number.isFinite(m.varianceB))
        return NONE;
    const scale = Math.sqrt(m.varianceA) * Math.sqrt(m.varianceB);
    if (scale === 0)
        return NONE;
    return result(m.covariance / scale);
}
/** `covariance(a, b, len)`: the population covariance, from bar `len - 1`. */
export function covarianceStep(state, key, pair, len) {
    return jointStep(state, key, pair, len, 'covariance');
}
/** `correlation(a, b, len)`: linear correlation, -1 to 1, from bar `len - 1`. */
export function correlationStep(state, key, pair, len) {
    return jointStep(state, key, pair, len, 'correlation');
}
/** `covariance(a, b, len)` as a tail. */
export function covarianceTail(len) {
    return tailOf((state, pair) => covarianceStep(state, 'q', pair, len));
}
/** `correlation(a, b, len)` as a tail. */
export function correlationTail(len) {
    return tailOf((state, pair) => correlationStep(state, 'q', pair, len));
}
function pairs(a, b) {
    return a.map((value, index) => ({ a: value, b: b[index] ?? NONE }));
}
/** `covariance(a, b, len)` over whole series. */
export function covariance(a, b, len) {
    return fold(covarianceTail(len), pairs(a, b));
}
/** `correlation(a, b, len)` over whole series. */
export function correlation(a, b, len) {
    return fold(correlationTail(len), pairs(a, b));
}
//# sourceMappingURL=statistics.js.map