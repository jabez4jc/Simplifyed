/** Exact real power rounded once, following section 20.10.3. */
import { integerSqrt } from './hypot.js';
import { ceil, exponentialEndpoint, floor, logarithm, parts, rounded } from './transcendental.js';
function oddParts(value) {
    let [integer, exponent] = parts(value);
    while ((integer & 1n) === 0n) {
        integer >>= 1n;
        exponent++;
    }
    return [integer, exponent];
}
/** Undefined requests intervals; null is an exactly determined overflow. */
function rationalResult(base, exponent) {
    let [odd, scale] = oddParts(base);
    let [numerator, shift] = oddParts(exponent);
    if (shift >= 0)
        numerator <<= BigInt(shift);
    else
        for (; shift < 0; shift++) {
            if (scale % 2 !== 0)
                return undefined;
            const root = integerSqrt(odd);
            if (root * root !== odd)
                return undefined;
            odd = root;
            scale /= 2;
        }
    if (odd === 1n) {
        const power = BigInt(scale) * numerator * (exponent < 0 ? -1n : 1n);
        if (power > 1023n)
            return null;
        if (power < -1075n)
            return 0;
        return rounded(1n, Number(power));
    }
    // These exact odd powers include every possible dyadic rounding midpoint.
    if (exponent > 0 && numerator <= 53n)
        return rounded(odd ** numerator, scale * Number(numerator));
    return undefined;
}
/** Internal kernel; a lower starting precision exposes refinement to tests. */
export function power(base, exponent, initialPrecision = 160) {
    if (!Number.isFinite(base) || !Number.isFinite(exponent))
        return null;
    if (exponent === 0)
        return 1;
    if (base === 0)
        return exponent > 0 ? 0 : null;
    if (base < 0 && !Number.isInteger(exponent))
        return null;
    const sign = base < 0 && exponent % 2 !== 0 ? -1 : 1;
    const magnitude = Math.abs(base);
    if (magnitude === 1)
        return sign;
    const signed = (value) => value === null ? null : value === 0 ? 0 : sign * value;
    const exact = rationalResult(magnitude, exponent);
    if (exact !== undefined)
        return signed(exact);
    const [multiplier, shift] = parts(exponent);
    for (let precision = Math.max(64, initialPrecision);; precision += 80) {
        let [low, high] = logarithm(magnitude, precision);
        low *= multiplier;
        high *= multiplier;
        if (shift >= 0) {
            low <<= BigInt(shift);
            high <<= BigInt(shift);
        }
        else {
            const divisor = 1n << BigInt(-shift);
            low = floor(low, divisor);
            high = ceil(high, divisor);
        }
        if (exponent < 0)
            [low, high] = [-high, -low];
        const below = exponentialEndpoint(low, precision), above = exponentialEndpoint(high, precision);
        if (below === undefined || above === undefined)
            continue;
        const left = below[0], right = above[1];
        if (Object.is(left, right))
            return signed(left);
    }
}
//# sourceMappingURL=power.js.map