const view = new DataView(new ArrayBuffer(8));
const mask = (1n << 52n) - 1n;
let defaultTwo;
let defaultTen;
export const bitLength = (x) => x === 0n ? 0 : x.toString(2).length;
export const floor = (n, d) => n >= 0n ? n / d : -((-n + d - 1n) / d);
export const ceil = (n, d) => -floor(-n, d);
export function parts(x) {
    view.setFloat64(0, Math.abs(x));
    const bits = view.getBigUint64(0), exponent = Number(bits >> 52n);
    return [exponent === 0 ? bits : (bits & mask) | (1n << 52n), exponent === 0 ? -1074 : exponent - 1075];
}
function fixed(x, precision) {
    const [m, e] = parts(x), shift = e + precision;
    return shift >= 0 ? [m << BigInt(shift), m << BigInt(shift)]
        : [m >> BigInt(-shift), ceil(m, 1n << BigInt(-shift))];
}
/** Round an exact dyadic endpoint directly, with the subnormal spacing floor. */
export function rounded(numerator, exponent) {
    if (numerator === 0n)
        return 0;
    const negative = numerator < 0n;
    const magnitude = negative ? -numerator : numerator;
    let spacing = Math.max(-1074, bitLength(magnitude) - 1 + exponent - 52);
    const shift = spacing - exponent;
    let significand;
    if (shift <= 0)
        significand = magnitude << BigInt(-shift);
    else {
        const divisor = 1n << BigInt(shift), remainder = magnitude % divisor;
        significand = magnitude / divisor;
        if (remainder * 2n > divisor || (remainder * 2n === divisor && (significand & 1n)))
            significand++;
    }
    if (significand === 0n)
        return 0;
    if (significand >= 1n << 53n) {
        significand >>= 1n;
        spacing++;
    }
    if (spacing > 971)
        return null;
    const bits = significand < 1n << 52n ? significand
        : (BigInt(spacing + 1075) << 52n) | (significand & mask);
    view.setBigUint64(0, bits | (negative ? 1n << 63n : 0n));
    return view.getFloat64(0);
}
/** Twice the positive odd-power sum, for 0 <= a/b <= 1/3. */
function oddSeries(a, b, precision) {
    if (a === 0n)
        return [0n, 0n];
    const unit = 1n << BigInt(precision), low = a * unit / b, high = ceil(a * unit, b);
    const squaredLow = low * low / unit, squaredHigh = ceil(high * high, unit);
    let powerLow = low, powerHigh = high, sumLow = 0n, sumHigh = 0n, odd = 1n;
    for (;;) {
        sumLow += powerLow / odd;
        sumHigh += ceil(powerHigh, odd);
        powerLow = powerLow * squaredLow / unit;
        powerHigh = ceil(powerHigh * squaredHigh, unit);
        odd += 2n;
        if (powerHigh <= 2n)
            return [2n * sumLow, 2n * (sumHigh + ceil(9n * powerHigh, 8n * odd))];
    }
}
function lnTwo(precision) {
    if (precision !== 160)
        return oddSeries(1n, 3n, precision);
    return defaultTwo ??= oddSeries(1n, 3n, precision);
}
export function logarithm(x, precision) {
    const [m, e] = parts(x), width = bitLength(m), one = 1n << BigInt(width - 1);
    const k = BigInt(e + width - 1), [low, high] = oddSeries(m - one, m + one, precision);
    const [constantLow, constantHigh] = lnTwo(precision);
    return k >= 0n ? [low + k * constantLow, high + k * constantHigh]
        : [low + k * constantHigh, high + k * constantLow];
}
function lnTen(precision) {
    if (precision !== 160)
        return logarithm(10, precision);
    return defaultTen ??= logarithm(10, precision);
}
function quotient(numerator, denominator, precision) {
    const unit = 1n << BigInt(precision);
    let low, high;
    for (const n of numerator)
        for (const d of denominator) {
            const below = floor(n * unit, d), above = ceil(n * unit, d);
            if (low === undefined || below < low)
                low = below;
            if (high === undefined || above > high)
                high = above;
        }
    return [low, high];
}
function exponentialRange(low, high, positive, precision) {
    const unit = 1n << BigInt(precision);
    const [constantLow, constantHigh] = lnTwo(precision), k = low / constantHigh;
    const reducedLow = low - k * constantHigh, reducedHigh = high - k * constantLow;
    if (reducedLow < 0n || reducedHigh >= unit)
        return undefined;
    let termLow = unit, termHigh = unit, sumLow = unit, sumHigh = unit, n = 0n;
    for (;;) {
        n++;
        termLow = termLow * reducedLow / (unit * n);
        termHigh = ceil(termHigh * reducedHigh, unit * n);
        if (termHigh <= 1n) {
            sumHigh += 2n * termHigh;
            break;
        }
        sumLow += termLow;
        sumHigh += termHigh;
    }
    return positive ? [sumLow, sumHigh, Number(k) - precision]
        : [unit * unit / sumHigh, ceil(unit * unit, sumLow), -Number(k) - precision];
}
/** Enclose exp(integer / 2**precision) without a binary64 intermediate. */
export function exponentialEndpoint(integer, precision) {
    const cutoff = 1024n << BigInt(precision);
    if (integer >= cutoff)
        return [null, null];
    if (integer <= -cutoff)
        return [0, 0];
    if (integer === 0n)
        return [1, 1];
    const magnitude = integer < 0n ? -integer : integer;
    const range = exponentialRange(magnitude, magnitude, integer > 0n, precision);
    if (range === undefined)
        return undefined;
    const [low, high, exponent] = range;
    return [rounded(low, exponent), rounded(high, exponent)];
}
/** Internal kernel. The optional starting precision permits refinement tests. */
export function transcendental(kind, x, initialPrecision = 160) {
    if (!Number.isFinite(x) || (kind !== 'exp' && x <= 0))
        return null;
    if (kind === 'exp') {
        if (x >= 1024)
            return null;
        if (x <= -1024)
            return 0;
        if (Math.abs(x) < 2 ** -60)
            return 1;
    }
    else {
        if (x === 1)
            return 0;
        if (kind === 'log2') {
            const [m, e] = parts(x);
            if ((m & (m - 1n)) === 0n)
                return e + bitLength(m) - 1;
        }
        if (kind === 'log10') {
            const [m, e] = parts(x);
            let integer = e >= 0 ? m << BigInt(e)
                : m % (1n << BigInt(-e)) === 0n ? m >> BigInt(-e) : 0n;
            let count = 0;
            while (integer > 1n && integer % 10n === 0n) {
                integer /= 10n;
                count++;
            }
            if (integer === 1n)
                return count;
        }
    }
    for (let precision = Math.max(64, initialPrecision);; precision += 80) {
        let low, high, exponent;
        if (kind === 'exp') {
            const [start, end] = fixed(x, precision);
            const range = exponentialRange(start, end, x >= 0, precision);
            if (range === undefined)
                continue;
            [low, high, exponent] = range;
        }
        else {
            const natural = logarithm(x, precision);
            [low, high] = kind === 'log' ? natural
                : quotient(natural, kind === 'log2' ? lnTwo(precision) : lnTen(precision), precision);
            exponent = -precision;
        }
        const left = rounded(low, exponent), right = rounded(high, exponent);
        if (Object.is(left, right))
            return left;
    }
}
//# sourceMappingURL=transcendental.js.map