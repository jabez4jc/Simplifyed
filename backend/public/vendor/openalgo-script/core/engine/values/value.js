/**
 * The six values a running program can hold, `compiled-program.md` 3.1.
 *
 * Absence is `null`, a number is a number, a boolean is a boolean and a string
 * is a string, so four of the six tags are the ones the host language already
 * carries and cost nothing to test. The two that have no native tag, a colour
 * and a reference, are objects carrying a `tag` field, so `typeof` answers the
 * question for every value in one step and no value can be mistaken for
 * another.
 *
 * **Absence is never a number.** Section 3.4 is explicit that a not-a-number
 * sentinel would make absence propagate through arithmetic by accident, which
 * is the right answer for four operators and the wrong one for six, and would
 * turn `isNone` into a floating point comparison. `null` has none of those
 * properties, and the two rules the arithmetic actually needs, absence in
 * gives absence out and a non-finite result becomes absent, are then written
 * once each rather than hidden inside a representation.
 *
 * **A reference is an integer into the heap, not a pointer to an object.**
 * That choice is what makes section 6.2's hardest requirement free: a
 * checkpoint copies the heap table, every reference in a restored cell is the
 * same integer it was, and two cells that shared an array still share it. A
 * representation that put the object itself in the cell would have to work out
 * which cells pointed at the same object and rebuild the graph, and a restore
 * that deep copied each cell separately would silently turn one array into two.
 */
/** Absence, the value a script writes `none`. */
export const ABSENT = null;
export function isAbsent(value) {
    return value === null;
}
export function isNumber(value) {
    return typeof value === 'number';
}
export function isBool(value) {
    return typeof value === 'boolean';
}
export function isString(value) {
    return typeof value === 'string';
}
export function isColour(value) {
    return typeof value === 'object' && value !== null && value.tag === 'color';
}
export function isRef(value) {
    return typeof value === 'object' && value !== null && value.tag === 'ref';
}
export function reference(id) {
    return { tag: 'ref', id };
}
/**
 * A number made safe to store, by the two rules of section 3.1 that hold at
 * every arithmetic result and every store.
 *
 * A result with no finite value is absent, checked here rather than at the end
 * of an expression so that `(1e308 * 10) / 10` is absent rather than depending
 * on where an engine happens to round. Negative zero becomes positive zero, so
 * nothing downstream can observe the sign of a zero and two engines cannot
 * differ over a minus in front of one.
 */
export function numberValue(x) {
    if (!Number.isFinite(x))
        return ABSENT;
    return x === 0 ? 0 : x;
}
/** Normalise numeric zero at a store or identity result, preserving every other tag. */
export function storedValue(value) {
    return typeof value === 'number' && value === 0 ? 0 : value;
}
/** The name of a value's tag, for a diagnostic that has to say what it found. */
export function tagOf(value) {
    if (value === null)
        return 'none';
    switch (typeof value) {
        case 'number':
            return 'number';
        case 'boolean':
            return 'bool';
        case 'string':
            return 'string';
        default:
            return value.tag === 'color' ? 'color' : 'reference';
    }
}
/**
 * Whole channels, and an alpha held to its range.
 *
 * `stdlib.md` 11.2 requires every call that computes a colour to round red,
 * green and blue with the language's own rounding, halves away from zero,
 * before it returns, so that the value model's invariant holds of every colour
 * and not only of a literal.
 */
export function colour(r, g, b, a) {
    return {
        tag: 'color',
        r: channel(r),
        g: channel(g),
        b: channel(b),
        a: a < 0 ? 0 : a > 1 ? 1 : a === 0 ? 0 : a,
    };
}
function channel(x) {
    if (!Number.isFinite(x))
        return 0;
    const rounded = halfAway(x);
    return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}
/** The language's rounding, halves away from zero, `stdlib.md` 8.1. */
function halfAway(x) {
    const below = Math.floor(x);
    const fraction = x - below;
    if (fraction > 0.5)
        return below + 1;
    if (fraction < 0.5)
        return below;
    return x > 0 ? below + 1 : below;
}
/**
 * Whether two values are equal under `EQ`, which is total: it always answers.
 *
 * Absent equals absent and nothing else. Two colours are equal when all four
 * channels match. Two references are equal when they are the same object,
 * which is `language.md` 9.3 and the reason `arrayEqual` exists in the library
 * for comparing contents.
 */
export function valuesEqual(a, b) {
    if (a === null || b === null)
        return a === b;
    if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'string') {
        return a === b;
    }
    if (typeof b !== 'object' || b === null)
        return false;
    if (a.tag === 'color') {
        return b.tag === 'color' && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
    }
    return b.tag === 'ref' && a.id === b.id;
}
//# sourceMappingURL=value.js.map