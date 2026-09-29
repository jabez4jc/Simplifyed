/**
 * The arithmetic calls, `stdlib.md` section 8.
 *
 * Every one of them is the numeric library's, called through. The numbers are
 * computed under `src/core/stdlib`, which depends on nothing else in the
 * repository and is tested against reference vectors on its own, and this file
 * is the wiring that hands it two engine values and takes one back. A second
 * implementation here would be a second accumulation order waiting to drift,
 * and section 8.3 makes that a release blocker rather than a tidiness problem.
 *
 * Three calls are not numeric and are here because they are written in the same
 * place in the library's own tables: `isNone`, `orElse` and `bool` take any
 * value, so they read the engine's value rather than a number.
 */
import { E, PI, abs, acos, asin, atan, atan2, ceil, clamp, cos, exp, floor, hypot, log, log10, log2, max, min, mod, pow, round, roundTo, roundToStep, sign, sin, sqrt, tan, toDegrees, toRadians, trunc, } from '../../stdlib/index.js';
import { isNumber, storedValue } from '../values/index.js';
import { entry, numberAt, valueAt, wholeAt } from './binding.js';
/** A one argument numeric call. */
function one(name, param, of) {
    return entry(name, param, (_ctx, args) => of(numberAt(args, 0)));
}
/** A two argument numeric call. */
function two(name, params, of) {
    return entry(name, params, (_ctx, args) => of(numberAt(args, 0), numberAt(args, 1)));
}
/** A constant read bare, which the format still compiles to a call of no arguments. */
function constant(name, value) {
    return entry(name, '', () => value);
}
export const MATHS_ENTRIES = [
    one('abs', 'x', abs),
    one('sign', 'x', sign),
    one('sqrt', 'x', sqrt),
    one('exp', 'x', exp),
    one('log', 'x', log),
    one('log10', 'x', log10),
    one('floor', 'x', floor),
    one('ceil', 'x', ceil),
    one('trunc', 'x', trunc),
    one('round', 'x', round),
    two('min', 'a b', min),
    two('max', 'a b', max),
    two('mod', 'a b', mod),
    two('pow', 'x y', pow),
    two('roundToStep', 'x step', roundToStep),
    entry('clamp', 'x lo hi', (_ctx, args) => clamp(numberAt(args, 0), numberAt(args, 1), numberAt(args, 2))),
    // The digit count is a whole number of zero or more. A fractional one is a
    // bug in the script rather than a value to round on the script's behalf.
    entry('round', 'x decimals', (ctx, args) => {
        const decimals = wholeAt(ctx, 'round', 'decimals', args, 1);
        return decimals === null ? null : roundTo(numberAt(args, 0), decimals);
    }),
    /**
     * `roundToTick(price)`: to the instrument's tick.
     *
     * Absent when the host states no tick size, rather than the price unrounded.
     * An order at a price that is not on a tick is refused by a venue, so a
     * script that cannot round has to be able to see that it cannot.
     */
    entry('roundToTick', 'price', (ctx, args) => {
        const tick = ctx.host.tickSize();
        if (!isNumber(tick))
            return null;
        return roundToStep(numberAt(args, 0), tick);
    }),
    constant('math.pi', PI),
    constant('math.e', E),
    one('math.log2', 'x', log2),
    one('math.sin', 'x', sin),
    one('math.cos', 'x', cos),
    one('math.tan', 'x', tan),
    one('math.asin', 'x', asin),
    one('math.acos', 'x', acos),
    one('math.atan', 'x', atan),
    one('math.toDegrees', 'x', toDegrees),
    one('math.toRadians', 'x', toRadians),
    two('math.hypot', 'x y', hypot),
    two('math.atan2', 'y x', atan2),
    entry('isNone', 'x', (_ctx, args) => valueAt(args, 0) === null),
    entry('orElse', 'x fallback', (_ctx, args) => {
        const value = valueAt(args, 0);
        return storedValue(value === null ? valueAt(args, 1) : value);
    }),
    // `toBool(x)`: absence to false, a bool to itself. A number is a type error
    // the checker refuses, so an engine that reaches one is looking at a program
    // its verifier should not have accepted, and absence is the safe reading.
    entry('toBool', 'x', (_ctx, args) => valueAt(args, 0) === true),
];
//# sourceMappingURL=maths.js.map