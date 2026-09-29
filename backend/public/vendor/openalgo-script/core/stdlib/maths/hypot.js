/** Exact two-argument hypotenuse, `stdlib.md` section 20.10.1. */
const view = new DataView(new ArrayBuffer(8));
const LEADING = 1n << 52n;
const FRACTION = LEADING - 1n;
function parts(value) {
    view.setFloat64(0, Math.abs(value), false);
    const encoded = view.getBigUint64(0, false);
    const exponent = Number(encoded >> 52n);
    return {
        significand: (encoded & FRACTION) | (exponent === 0 ? 0n : LEADING),
        exponent: exponent === 0 ? -1074 : exponent - 1075,
    };
}
function decode(encoded) {
    view.setBigUint64(0, encoded, false);
    return view.getFloat64(0, false);
}
/** A power-of-two upper bound makes integer Newton steps decrease to the floor. */
export function integerSqrt(value) {
    if (value < 2n)
        return value;
    let before = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
    for (;;) {
        const next = (before + value / before) >> 1n;
        if (next >= before)
            return before;
        before = next;
    }
}
/**
 * Keep the squared sum exact, then compare against a squared rounding midpoint.
 * Binary64 input widths bound every temporary integer to fewer than 4,200 bits.
 */
export function hypotenuse(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    if (x === 0)
        return Math.abs(y);
    if (y === 0)
        return Math.abs(x);
    const a = parts(x);
    const b = parts(y);
    const exponent = Math.min(a.exponent, b.exponent);
    const square = (a.significand * a.significand << BigInt(2 * (a.exponent - exponent))) +
        (b.significand * b.significand << BigInt(2 * (b.exponent - exponent)));
    const top = square.toString(2).length - 1;
    let spacing = Math.max(-1074, exponent + Math.floor(top / 2) - 52);
    const shift = exponent - spacing;
    const numerator = shift < 0 ? square : square << BigInt(2 * shift);
    const denominator = shift < 0 ? 1n << BigInt(-2 * shift) : 1n;
    let significand = integerSqrt(numerator / denominator);
    const midpoint = 2n * significand + 1n;
    const comparison = 4n * numerator - denominator * midpoint * midpoint;
    if (comparison > 0n || comparison === 0n && (significand & 1n) !== 0n)
        significand += 1n;
    if (significand >= 2n * LEADING) {
        significand >>= 1n;
        spacing += 1;
    }
    // Encoding after rounding avoids a second rounding through a floating scale.
    if (significand < LEADING)
        return decode(significand);
    const encodedExponent = spacing + 1075;
    if (encodedExponent >= 2047)
        return null;
    return decode(BigInt(encodedExponent) << 52n | (significand - LEADING));
}
//# sourceMappingURL=hypot.js.map