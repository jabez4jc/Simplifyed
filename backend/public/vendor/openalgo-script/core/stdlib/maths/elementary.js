import { NONE, isPresent, result } from '../values/index.js';
import { hypotenuse } from './hypot.js';
import { transcendental } from './transcendental.js';
import { power } from './power.js';
import { trigonometric } from './trigonometric.js';
/**
 * `sqrt(x)`: square root, absent below zero.
 *
 * Correctly rounded on every conforming platform, so this one is bit-identical
 * everywhere without a portable implementation of its own.
 */
export function sqrt(x) {
    if (!isPresent(x) || x < 0)
        return NONE;
    return result(Math.sqrt(x));
}
/** `pow(x, y)`: absent where the result is not a finite real. */
export function pow(x, y) {
    if (!isPresent(x) || !isPresent(y))
        return NONE;
    return power(x, y);
}
/** `exp(x)`: e to the power x. */
export function exp(x) {
    return isPresent(x) ? transcendental('exp', x) : NONE;
}
/** `log(x)`: natural logarithm, absent at or below zero. */
export function log(x) {
    if (!isPresent(x) || x <= 0)
        return NONE;
    return transcendental('log', x);
}
/** `log10(x)`: base ten logarithm, absent at or below zero. */
export function log10(x) {
    if (!isPresent(x) || x <= 0)
        return NONE;
    return transcendental('log10', x);
}
/** `math.log2(x)`: base two logarithm, absent at or below zero. */
export function log2(x) {
    if (!isPresent(x) || x <= 0)
        return NONE;
    return transcendental('log2', x);
}
/** The circle constant. */
export const PI = Math.PI;
/** The base of the natural logarithm. */
export const E = Math.E;
/** `math.hypot(x, y)`: `sqrt(x * x + y * y)` without intermediate overflow. */
export function hypot(x, y) {
    if (!isPresent(x) || !isPresent(y))
        return NONE;
    return hypotenuse(x, y);
}
/** `math.toDegrees(x)`: radians to degrees. */
export function toDegrees(x) {
    return isPresent(x) ? result((x * 180) / Math.PI) : NONE;
}
/** `math.toRadians(x)`: degrees to radians. */
export function toRadians(x) {
    return isPresent(x) ? result((x * Math.PI) / 180) : NONE;
}
/** `math.sin(x)`: sine of an angle in radians. */
export function sin(x) {
    return isPresent(x) ? trigonometric('sin', x) : NONE;
}
/** `math.cos(x)`: cosine. */
export function cos(x) {
    return isPresent(x) ? trigonometric('cos', x) : NONE;
}
/** `math.tan(x)`: tangent. */
export function tan(x) {
    return isPresent(x) ? trigonometric('tan', x) : NONE;
}
/** `math.asin(x)`: inverse sine, absent outside -1 to 1. */
export function asin(x) {
    if (!isPresent(x) || x < -1 || x > 1)
        return NONE;
    return trigonometric('asin', x);
}
/** `math.acos(x)`: inverse cosine, absent outside -1 to 1. */
export function acos(x) {
    if (!isPresent(x) || x < -1 || x > 1)
        return NONE;
    return trigonometric('acos', x);
}
/** `math.atan(x)`: inverse tangent. */
export function atan(x) {
    return isPresent(x) ? trigonometric('atan', x) : NONE;
}
/** `math.atan2(y, x)`: angle of a vector, correct in all four quadrants. */
export function atan2(y, x) {
    if (!isPresent(y) || !isPresent(x))
        return NONE;
    return trigonometric('atan2', y, x);
}
//# sourceMappingURL=elementary.js.map