/** Directed integer enclosures for the real-result recipe in section 20.10.4. */
import { bitLength, ceil, floor, parts, rounded } from './transcendental.js';
import { integerSqrt } from './hypot.js';
let cachedPi = { precision: 0, value: [0n, 0n] };
const negate = (a) => [-a[1], -a[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const subtract = (a, b) => [a[0] - b[1], a[1] - b[0]];
const absolute = (n) => n < 0n ? -n : n;
function ratio(x) {
    const [mantissa, exponent] = parts(x);
    return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}
function coarsen(a, shift) {
    const divisor = 1n << BigInt(shift);
    return [floor(a[0], divisor), ceil(a[1], divisor)];
}
function quotient(a, b, precision) {
    if (b[0] <= 0n && b[1] >= 0n)
        return null;
    const scale = 1n << BigInt(precision);
    let low, high;
    for (const numerator of a)
        for (const denominator of b) {
            const n = denominator < 0n ? -numerator : numerator, d = absolute(denominator);
            const lower = floor(n * scale, d), upper = ceil(n * scale, d);
            if (low === undefined || lower < low)
                low = lower;
            if (high === undefined || upper > high)
                high = upper;
        }
    return [low, high];
}
/** Alternating odd powers, with the first omitted term on its signed side. */
function smallAtan(n, d, precision) {
    if (n === 0n)
        return [0n, 0n];
    if (n < 0n)
        return negate(smallAtan(-n, d, precision));
    const scale = 1n << BigInt(precision), zl = n * scale / d, zh = ceil(n * scale, d);
    const squaredLow = zl * zl / scale, squaredHigh = ceil(zh * zh, scale);
    let powerLow = zl, powerHigh = zh, low = 0n, high = 0n, odd = 1n, positive = true;
    for (;;) {
        const lower = powerLow / odd, upper = ceil(powerHigh, odd);
        if (positive) {
            low += lower;
            high += upper;
        }
        else {
            low -= upper;
            high -= lower;
        }
        powerLow = powerLow * squaredLow / scale;
        powerHigh = ceil(powerHigh * squaredHigh, scale);
        odd += 2n;
        positive = !positive;
        if (powerHigh <= 1n) {
            const tail = ceil(powerHigh, odd);
            return positive ? [low, high + tail] : [low - tail, high];
        }
    }
}
function pi(precision) {
    if (cachedPi.precision >= precision)
        return coarsen(cachedPi.value, cachedPi.precision - precision);
    const a = smallAtan(1n, 5n, precision), b = smallAtan(1n, 239n, precision);
    const value = [16n * a[0] - 4n * b[1], 16n * a[1] - 4n * b[0]];
    cachedPi = { precision, value };
    return value;
}
function positiveAtan(n, d, precision) {
    if (n === 0n)
        return [0n, 0n];
    if (d === 0n)
        return coarsen(pi(precision), 1);
    if (n > d)
        return subtract(coarsen(pi(precision), 1), positiveAtan(d, n, precision));
    if (2n * n > d)
        return add(coarsen(pi(precision), 2), smallAtan(n - d, n + d, precision));
    return smallAtan(n, d, precision);
}
function pointSeries(z, precision, cosine) {
    if (z < 0n) {
        const out = pointSeries(-z, precision, cosine);
        return cosine ? out : negate(out);
    }
    const scale = 1n << BigInt(precision);
    if (z === 0n)
        return cosine ? [scale, scale] : [0n, 0n];
    const squaredLow = z * z / scale, squaredHigh = ceil(z * z, scale);
    let low = cosine ? scale : z, high = low, termLow = low, termHigh = low;
    let degree = cosine ? 0n : 1n, positive = false;
    for (;;) {
        const divisor = scale * (degree + 1n) * (degree + 2n);
        termLow = termLow * squaredLow / divisor;
        termHigh = ceil(termHigh * squaredHigh, divisor);
        degree += 2n;
        if (termHigh <= 1n)
            return positive ? [low, high + termHigh] : [low - termHigh, high];
        if (positive) {
            low += termLow;
            high += termHigh;
        }
        else {
            low -= termHigh;
            high -= termLow;
        }
        positive = !positive;
    }
}
function reducedSinCos(x, precision) {
    const [n, d] = ratio(x);
    const reductionPrecision = precision + Math.max(0, bitLength(n) - bitLength(d)) + 32;
    const scale = 1n << BigInt(reductionPrecision), [pl, ph] = pi(reductionPrecision);
    const ql = (4n * n * scale + d * ph) / (2n * d * ph);
    const qh = (4n * n * scale + d * pl) / (2n * d * pl);
    if (ql !== qh)
        return null;
    const residual = [n * scale / d - ceil(ql * ph, 2n), ceil(n * scale, d) - ql * pl / 2n];
    const [lower, upper] = coarsen(residual, reductionPrecision - precision);
    const unit = 1n << BigInt(precision);
    if (lower < -unit || upper > unit)
        return null;
    let sine = [pointSeries(lower, precision, false)[0], pointSeries(upper, precision, false)[1]];
    const a = absolute(lower), b = absolute(upper), far = a > b ? a : b;
    const near = lower <= 0n && upper >= 0n ? 0n : a < b ? a : b;
    let cosine = [pointSeries(far, precision, true)[0], pointSeries(near, precision, true)[1]];
    switch (Number(ql % 4n)) {
        case 1:
            [sine, cosine] = [cosine, negate(sine)];
            break;
        case 2:
            [sine, cosine] = [negate(sine), negate(cosine)];
            break;
        case 3:
            [sine, cosine] = [negate(cosine), sine];
            break;
    }
    return [x < 0 ? negate(sine) : sine, cosine];
}
function inverse(kind, x, y, precision) {
    if (kind === 'atan') {
        const [n, d] = ratio(x), out = positiveAtan(n, d, precision);
        return x < 0 ? negate(out) : out;
    }
    if (kind === 'atan2') {
        if (x === 0)
            return y > 0 ? coarsen(pi(precision), 1) : negate(coarsen(pi(precision), 1));
        const [yn, yd] = ratio(y), [xn, xd] = ratio(x);
        let out = positiveAtan(yn * xd, xn * yd, precision);
        if (x < 0)
            out = subtract(pi(precision), out);
        return y < 0 ? negate(out) : out;
    }
    const [n, d] = ratio(x), scale = 1n << BigInt(precision);
    const radicand = (d * d - n * n) * scale * scale, root = integerSqrt(radicand / (d * d));
    const upper = root + (root * root * d * d === radicand ? 0n : 1n);
    if (kind === 'asin') {
        const out = [positiveAtan(n * scale, d * upper, precision)[0], positiveAtan(n * scale, d * root, precision)[1]];
        return x < 0 ? negate(out) : out;
    }
    const out = [positiveAtan(root * d, n * scale, precision)[0], positiveAtan(upper * d, n * scale, precision)[1]];
    return x < 0 ? subtract(pi(precision), out) : out;
}
/** The ordinary argument order is preserved, including atan2(y,x). */
export function trigonometric(kind, first, second, start = 160) {
    if (!Number.isFinite(first) || kind === 'atan2' && !Number.isFinite(second))
        return null;
    const x = kind === 'atan2' ? second : first, y = kind === 'atan2' ? first : 0;
    if ((kind === 'asin' || kind === 'acos') && Math.abs(x) > 1)
        return null;
    if (kind === 'atan2' && y === 0 && x >= 0)
        return 0;
    if (x === 0 && kind !== 'atan2') {
        if (kind === 'cos')
            return 1;
        if (kind !== 'acos')
            return 0;
    }
    if (kind === 'acos' && x === 1)
        return 0;
    for (let precision = Math.max(64, start);; precision += 80) {
        let interval;
        if (kind === 'sin' || kind === 'cos' || kind === 'tan') {
            const both = reducedSinCos(x, precision);
            interval = both === null ? null : kind === 'sin' ? both[0] : kind === 'cos' ? both[1] : quotient(both[0], both[1], precision);
        }
        else
            interval = inverse(kind, x, y, precision);
        if (interval !== null) {
            const left = rounded(interval[0], -precision), right = rounded(interval[1], -precision);
            if (left === right)
                return left;
        }
    }
}
//# sourceMappingURL=trigonometric.js.map