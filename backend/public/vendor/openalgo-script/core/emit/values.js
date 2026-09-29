import { withoutGrouping } from '../ast/index.js';
import { FOLDABLE_CALLS } from '../check/index.js';
import { hexColour, namedColour } from './colours.js';
export const ABSENT = { kind: 'absent' };
/** The language's own rounding, halves away from zero, `stdlib.md` 8.1. */
export function roundHalfAway(x) {
    return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}
/** Normalises a negative zero, which nothing in the language can observe (3.1). */
function noNegativeZero(x) {
    return x === 0 ? 0 : x;
}
function at(colour, index) {
    return colour[index] ?? 0;
}
function colourOf(value) {
    return value !== undefined && value.kind === 'colour' ? value.value : undefined;
}
function numberOf(value) {
    return value !== undefined && value.kind === 'number' ? value.value : undefined;
}
function channel(x) {
    return roundHalfAway(x);
}
/**
 * The colour calls of `stdlib.md` 11.2 that a declaration field can hold.
 *
 * `mix` is included because it is the call that produces fractional channels
 * and is therefore the one where the rounding rule bites; `alpha` is included
 * because it returns a number and a script may use one in a field.
 *
 * Which names those are is the checker's `FOLDABLE_CALLS`, and is read from
 * there rather than repeated here: the checker accepts a call in a field that
 * has to be fixed before bar 0 on the strength of this folding it, so the two
 * lists being one list is what keeps the compiler from refusing a script it had
 * already passed.
 */
function foldColourCall(name, args) {
    if (!FOLDABLE_CALLS.has(name))
        return undefined;
    if (name === 'rgb' || name === 'rgba') {
        const r = numberOf(args[0]);
        const g = numberOf(args[1]);
        const b = numberOf(args[2]);
        const a = name === 'rgba' ? numberOf(args[3]) : 1;
        if (r === undefined || g === undefined || b === undefined || a === undefined)
            return undefined;
        return { kind: 'colour', value: [channel(r), channel(g), channel(b), a] };
    }
    if (name === 'fade' || name === 'withAlpha') {
        const colour = colourOf(args[0]);
        const amount = numberOf(args[1]);
        if (colour === undefined || amount === undefined)
            return undefined;
        // fade takes transparency as a percentage and sets the alpha absolutely.
        const alpha = name === 'fade' ? (100 - amount) / 100 : amount;
        return { kind: 'colour', value: [colour[0], colour[1], colour[2], alpha] };
    }
    if (name === 'alpha') {
        const colour = colourOf(args[0]);
        return colour === undefined ? undefined : { kind: 'number', value: colour[3] };
    }
    if (name === 'mix') {
        const a = colourOf(args[0]);
        const b = colourOf(args[1]);
        const weight = numberOf(args[2]);
        if (a === undefined || b === undefined || weight === undefined)
            return undefined;
        const blend = (i) => channel(at(a, i) + (at(b, i) - at(a, i)) * weight);
        return {
            kind: 'colour',
            value: [blend(0), blend(1), blend(2), a[3] + (b[3] - a[3]) * weight],
        };
    }
    return undefined;
}
function foldArithmetic(operator, left, right) {
    if (operator === '+' && left.kind === 'string' && right.kind === 'string') {
        return { kind: 'string', value: left.value + right.value };
    }
    if (left.kind !== 'number' || right.kind !== 'number')
        return undefined;
    const a = left.value;
    const b = right.value;
    let result;
    switch (operator) {
        case '+':
            result = a + b;
            break;
        case '-':
            result = a - b;
            break;
        case '*':
            result = a * b;
            break;
        case '/':
            if (b === 0)
                return ABSENT;
            result = a / b;
            break;
        case '%':
            if (b === 0)
                return ABSENT;
            result = a % b;
            break;
        default:
            return undefined;
    }
    // Any result that is not finite is absent, checked after each operation (3.1).
    return Number.isFinite(result)
        ? { kind: 'number', value: noNegativeZero(result) }
        : ABSENT;
}
/**
 * The value an expression has before bar 0, or nothing when it has none.
 *
 * Nothing here reports a diagnostic. An expression the checker already accepted
 * as a compile-time constant and this refuses is a shape the format cannot
 * carry, and the caller is the one that knows which field it was going into.
 */
export function fold(expression, environment) {
    const inner = withoutGrouping(expression);
    switch (inner.kind) {
        case 'numberLiteral':
            return { kind: 'number', value: noNegativeZero(inner.value) };
        case 'stringLiteral':
            return { kind: 'string', value: inner.value };
        case 'booleanLiteral':
            return { kind: 'bool', value: inner.value };
        case 'noneLiteral':
            return ABSENT;
        case 'colorLiteral': {
            const colour = hexColour(inner.text);
            return colour === undefined ? undefined : { kind: 'colour', value: colour };
        }
        case 'nameReference': {
            const named = namedColour(inner.name);
            if (named !== undefined)
                return { kind: 'colour', value: named };
            return environment.name(inner);
        }
        case 'member': {
            const object = withoutGrouping(inner.object);
            if (object.kind !== 'nameReference' || object.name !== 'math')
                return undefined;
            if (inner.member.text === 'pi')
                return { kind: 'number', value: Math.PI };
            if (inner.member.text === 'e')
                return { kind: 'number', value: Math.E };
            return undefined;
        }
        case 'arrayLiteral': {
            const values = [];
            for (const element of inner.elements) {
                const value = fold(element, environment);
                if (value === undefined)
                    return undefined;
                // A reference stands **in place of** a field's value and never inside
                // one, so `range = [input(0, "Low"), 100]` has nowhere in the format to
                // live and is refused here rather than written as an absent range.
                if (value.kind === 'input')
                    return undefined;
                values.push(value);
            }
            return { kind: 'array', values };
        }
        case 'unary': {
            const operand = fold(inner.operand, environment);
            if (operand === undefined)
                return undefined;
            if (operand.kind === 'absent')
                return ABSENT;
            if (inner.operator === 'not') {
                return operand.kind === 'bool' ? { kind: 'bool', value: !operand.value } : undefined;
            }
            if (operand.kind !== 'number')
                return undefined;
            const value = inner.operator === '-' ? -operand.value : operand.value;
            return { kind: 'number', value: noNegativeZero(value) };
        }
        case 'binary': {
            const left = fold(inner.left, environment);
            const right = fold(inner.right, environment);
            if (left === undefined || right === undefined)
                return undefined;
            if (left.kind === 'absent' || right.kind === 'absent')
                return ABSENT;
            return foldArithmetic(inner.operator, left, right);
        }
        case 'ternary': {
            const condition = fold(inner.condition, environment);
            if (condition === undefined || condition.kind !== 'bool')
                return undefined;
            return fold(condition.value ? inner.whenTrue : inner.whenFalse, environment);
        }
        case 'call': {
            const resolved = environment.call(inner);
            if (resolved === undefined)
                return undefined;
            // An `input()` written in place is the reference of 2.3, exactly as the
            // name a script bound one to is. `language.md` 13.2 admits both spellings
            // of an option value and the declaration line can only write this one:
            // it is the first statement of the file, so there is no name above it.
            if (resolved.name === 'input')
                return environment.input(inner);
            const args = resolved.args.map((one) => one === undefined ? undefined : fold(one.value, environment));
            return foldColourCall(resolved.name, args);
        }
        default:
            return undefined;
    }
}
/**
 * A folded value as a declaration field, `compiled-program.md` 2.3.
 *
 * Absence is null, because absence is what an argument a script named none for
 * resolves to and null is the effective value rather than a missing one. An
 * input is carried as its reference and is resolved away before bar 0.
 */
export function fieldOf(value) {
    if (value === undefined)
        return null;
    switch (value.kind) {
        case 'absent':
            return null;
        case 'bool':
            return value.value;
        case 'number':
            return value.value;
        case 'string':
            return value.value;
        case 'colour':
            return value.value;
        case 'input':
            return { input: value.key };
        case 'array': {
            const numbers = value.values.map((one) => (one.kind === 'number' ? one.value : Number.NaN));
            return numbers.some((one) => Number.isNaN(one)) ? null : numbers;
        }
    }
}
//# sourceMappingURL=values.js.map