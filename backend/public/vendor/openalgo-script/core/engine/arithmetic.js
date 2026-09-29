/**
 * The operator instructions, `compiled-program.md` 4.5 to 4.7.
 *
 * Five rules live in this file and nowhere else, which is section 7's claim
 * about the whole language: absence propagates through arithmetic and ordering
 * comparison, is total under equality, is three-valued under `and`, `or` and
 * `not`, and is false at a branch. The last one is `JUMP_FALSE` and is in the
 * machine; the other four are here. An engine that gets all five right has the
 * whole of `language.md` section 6, and an engine that special cases absence
 * anywhere else has a bug.
 *
 * Two details that look like nothing and are not:
 *
 * **Finiteness is checked after each individual operation**, not at the end of
 * an expression, so `(1e308 * 10) / 10` is absent rather than `1e307`. Checking
 * per expression would make the answer depend on where an engine happened to
 * round, which is the whole failure this project exists to prevent.
 *
 * **`MOD` is truncated division and the library's `mod` is floored.** They are
 * different functions with the same name in two places on purpose: the operator
 * follows the sign of its left operand, which is what every language's `%`
 * does, and the library call follows the sign of its right operand, which is
 * what a script wants when it wraps an index. Collapsing them would silently
 * change one of the two.
 */
import { compareStrings } from './library/index.js';
import { ABSENT, numberValue, valuesEqual } from './values/index.js';
/** Whether a corrupt program reached an operator with tags it cannot take. */
export class OperandMismatch extends Error {
    opcode;
    constructor(opcode) {
        super(opcode);
        this.name = 'OperandMismatch';
        this.opcode = opcode;
    }
}
/**
 * `ADD`: the sum of two numbers, or the concatenation of two strings.
 *
 * The only instruction that reads two tags. Any other combination is a program
 * the checker should have rejected, and an engine treats it as corrupt rather
 * than inventing a conversion: `language.md` 5.3 has no coercion anywhere, and
 * an engine that grows one here becomes the only engine that runs that script.
 */
export function add(a, b) {
    if (a === null || b === null)
        return ABSENT;
    if (typeof a === 'number' && typeof b === 'number')
        return numberValue(a + b);
    if (typeof a === 'string' && typeof b === 'string')
        return a + b;
    throw new OperandMismatch('ADD');
}
export function subtract(a, b) {
    return numeric('SUB', a, b, (x, y) => x - y);
}
export function multiply(a, b) {
    return numeric('MUL', a, b, (x, y) => x * y);
}
/** `DIV`: absent when the divisor is zero, including `0 / 0`. */
export function divide(a, b) {
    if (a === null || b === null)
        return ABSENT;
    if (typeof a !== 'number' || typeof b !== 'number')
        throw new OperandMismatch('DIV');
    return b === 0 ? ABSENT : numberValue(a / b);
}
/** `MOD`: the remainder of truncated division, sign following the left operand. */
export function remainder(a, b) {
    if (a === null || b === null)
        return ABSENT;
    if (typeof a !== 'number' || typeof b !== 'number')
        throw new OperandMismatch('MOD');
    return b === 0 ? ABSENT : numberValue(a % b);
}
export function negate(a) {
    if (a === null)
        return ABSENT;
    if (typeof a !== 'number')
        throw new OperandMismatch('NEG');
    return numberValue(-a);
}
function numeric(opcode, a, b, of) {
    if (a === null || b === null)
        return ABSENT;
    if (typeof a !== 'number' || typeof b !== 'number')
        throw new OperandMismatch(opcode);
    return numberValue(of(a, b));
}
/**
 * The four ordering comparisons, which **propagate absence**.
 *
 * An absent operand gives absence rather than `false` (`language.md` 6.4).
 * Together with `EQ` being total, this is the one place in the language where
 * absence is treated two ways, and it is deliberate: an operator that can
 * itself be absent gives a script no way to ask whether a value is absent at
 * all, so equality is the exception and every other comparison is not.
 *
 * **Two strings are ordered by code point** (`language.md` 9.3, `stdlib.md`
 * section 10), through the one order `sort` uses, and not by the host's own
 * operator, which orders by sixteen bit unit and puts a symbol outside the
 * basic plane below the last thousands of the plane. Numbers take the host's
 * operator, which is the binary64 order every engine shares.
 */
export function compare(opcode, a, b) {
    if (a === null || b === null)
        return ABSENT;
    if (typeof a === 'string' && typeof b === 'string')
        return ordered(opcode, compareStrings(a, b));
    if (typeof a !== 'number' || typeof b !== 'number')
        throw new OperandMismatch(opcode);
    switch (opcode) {
        case 'LT':
            return a < b;
        case 'LE':
            return a <= b;
        case 'GT':
            return a > b;
        default:
            return a >= b;
    }
}
/** An ordering comparison read off a three way order: negative, zero or positive. */
function ordered(opcode, order) {
    switch (opcode) {
        case 'LT':
            return order < 0;
        case 'LE':
            return order <= 0;
        case 'GT':
            return order > 0;
        default:
            return order >= 0;
    }
}
/** `EQ` and `NE` are total: they always produce a boolean. */
export function equals(a, b) {
    return valuesEqual(a, b);
}
/** `NOT`: true becomes false, false becomes true, absent stays absent. */
export function not(a) {
    if (a === null)
        return ABSENT;
    if (typeof a !== 'boolean')
        throw new OperandMismatch('NOT');
    return !a;
}
/**
 * `AND`, the three-valued conjunction of `language.md` 6.6.
 *
 * The table holds only the cases the short circuit leaves to it: `AND_SHORT`
 * has already decided a `false` left operand. A `false` on the right fixes the
 * answer whatever an absent left operand would have held, which is what makes
 * the operator commutative.
 */
export function and(a, b) {
    if (a === false || b === false)
        return false;
    if (a === null || b === null)
        return ABSENT;
    if (typeof a !== 'boolean' || typeof b !== 'boolean')
        throw new OperandMismatch('AND');
    return a && b;
}
/** `OR`, the disjunction beside it. A `true` on either side fixes the answer. */
export function or(a, b) {
    if (a === true || b === true)
        return true;
    if (a === null || b === null)
        return ABSENT;
    if (typeof a !== 'boolean' || typeof b !== 'boolean')
        throw new OperandMismatch('OR');
    return a || b;
}
/**
 * Whether a branch is taken, which is the fifth rule.
 *
 * `JUMP_FALSE` treats absence as false. This is the one place absence is
 * absorbed rather than propagated, and it is unavoidable: execution has to go
 * somewhere. It serves `if`, `else if`, `while`, the ternary and a `switch`
 * condition arm, so the rule is written once in one instruction.
 */
export function isFalsey(value) {
    return value === false || value === null;
}
//# sourceMappingURL=arithmetic.js.map