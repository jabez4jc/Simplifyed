/**
 * Strings and formatting, `stdlib.md` section 10.
 *
 * **A string is a sequence of code points** (`compiled-program.md` 3.1), so
 * length, indexing and comparison count code points and not the storage unit of
 * the language this engine happens to be written in. An engine whose native
 * strings are sixteen bit units must count and index past a surrogate pair as
 * one element, or two engines will disagree about the length of a string
 * holding a symbol outside the basic plane and about every substring taken
 * after one. That is what the spread into an array is doing everywhere below:
 * it costs a pass over the string and buys agreement. The trimmed set and the
 * order of two strings are in `code-points.ts`, written from the page.
 *
 * **Number to string is specified, not the host's default.** `text(x)` is the
 * rule of `language.md` 5.5 and goes through the one writer that implements
 * it, `canonicalNumber`, as does every digit this file writes: a host's own
 * conversion is never asked. `text(x, d)` rounds to `d` decimals with halves
 * away from zero and always emits exactly `d` digits after the point, because
 * this is a display conversion and half up is what a reader of a price expects.
 */
import { canonicalNumber } from '../../emit/index.js';
import { roundHalfAway, scaleOf } from '../../stdlib/index.js';
import { isColour, reference } from '../values/index.js';
import { entry, numberAt, refAt, stringAt, valueAt, wholeAt } from './binding.js';
import { points, trimmed } from './code-points.js';
/** A value as `text(x)` spells it. */
export function spell(ctx, value) {
    if (value === null)
        return 'none';
    if (typeof value === 'number')
        return canonicalNumber(value);
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'string')
        return value;
    if (isColour(value)) {
        const alpha = roundHalfAway(value.a * 255);
        return `#${hexByte(value.r)}${hexByte(value.g)}${hexByte(value.b)}${hexByte(alpha)}`;
    }
    return ctx.heap.get(value.id)?.kind ?? 'none';
}
/**
 * A whole number from 0 to 255 as two hex digits, from a table.
 *
 * A colour's channels are whole numbers (`compiled-program.md` 3.1), so this
 * is not the decimal rendering rule and asks no host conversion: each nibble
 * indexes a string of sixteen characters.
 */
const HEX_DIGITS = '0123456789abcdef';
function hexByte(channel) {
    return `${HEX_DIGITS[channel >> 4] ?? '0'}${HEX_DIGITS[channel & 15] ?? '0'}`;
}
/**
 * A written magnitude as digits, with the point moved right by `places`.
 *
 * **This is the only place an exponent is allowed to exist.** A runtime writes
 * a large enough magnitude in exponential form, and `1e+22` reaching a routine
 * that splits a whole part from a fraction comes back out as `1e+.22`: a label
 * on a price or a cumulative volume with nonsense in it, and no diagnostic
 * anywhere. So the exponent is taken off here, once, and everything after this
 * works on digits and a position, where moving the point is arithmetic on an
 * integer and cannot produce a character that was not a digit.
 *
 * It takes the writing rather than the number because the two callers need two
 * different ones, and which digits a magnitude has is their question, not this
 * one's.
 */
function spread(shown, places) {
    const e = shown.indexOf('e');
    const mantissa = e < 0 ? shown : shown.slice(0, e);
    const exponent = e < 0 ? 0 : Number(shown.slice(e + 1));
    const dot = mantissa.indexOf('.');
    const whole = dot < 0 ? mantissa : mantissa.slice(0, dot);
    const fraction = dot < 0 ? '' : mantissa.slice(dot + 1);
    return { digits: whole + fraction, point: whole.length + exponent + places };
}
/** One added to a digit string, which grows it when every digit is a nine. */
function carry(digits) {
    const out = [...digits];
    for (let i = out.length - 1; i >= 0; i -= 1) {
        const digit = out[i] ?? '0';
        if (digit !== '9') {
            out[i] = String.fromCharCode(digit.charCodeAt(0) + 1);
            return out.join('');
        }
        out[i] = '0';
    }
    return `1${out.join('')}`;
}
/**
 * A spread written out, rounded half up where the point falls inside its digits.
 *
 * Both callers pass a point at or past the last digit, so the first line is the
 * answer every time either of them asks. The rest is here so that this is a
 * function of what it is given rather than of that reasoning, and half up on a
 * magnitude is half away from zero because the sign is carried separately.
 */
function written(of) {
    if (of.point >= of.digits.length)
        return of.digits + '0'.repeat(of.point - of.digits.length);
    if (of.point < 0)
        return '0';
    const kept = of.digits.slice(0, of.point);
    if ((of.digits[of.point] ?? '0') < '5')
        return kept === '' ? '0' : kept;
    return carry(kept);
}
/**
 * `text(x, d)`: exactly `d` digits after the point, halves away from zero.
 *
 * The rounding is done on the number before it is written out rather than left
 * to a formatting routine, because a routine's tie rule is the host language's
 * and the two disagree at exactly the values a price lands on.
 *
 * **The result is positional, always**, whatever the magnitude: a sign, at
 * least one digit, and exactly `d` digits after the point. `spread` is what
 * makes that true of every magnitude rather than of the ones below a threshold.
 *
 * **The scale is `round(x, d)`'s**, `scaleOf` from the numeric library, so
 * the display conversion and the rounding call multiply by one value
 * (`stdlib.md` 20.7) and cannot part by an ulp at the one count where the
 * host's power does.
 *
 * **The digits are the shortest form's, zero filled, at every magnitude.**
 * Below 2 ** 53 a rounded whole number has no digits but its own, so nothing
 * ordinary changes; at or above it the shortest form is what both engines
 * write, and it is what this uses inside the scaling range as well as past it,
 * where scaling by ten to the `d` leaves binary64 altogether and there is
 * nothing to round: a binary64 that large is a whole number already, and a
 * decimal place that far from the leading digit is past every digit the value
 * carries. One rule for the digits at every magnitude, rather than the exact
 * binary expansion below a threshold and the shortest form above it.
 */
function fixed(x, decimals) {
    const scaled = roundHalfAway(x * scaleOf(decimals));
    const usable = Number.isFinite(scaled);
    const sign = (usable ? scaled < 0 : x < 0) ? '-' : '';
    // The digits are the shortest form's at every magnitude, through the one
    // writer: a rounded whole below 2 ** 53 has no other digits, and above it
    // the shortest form is the one rule both engines write (language.md 5.5).
    const magnitude = usable
        ? spread(canonicalNumber(Math.abs(scaled)), 0)
        : spread(canonicalNumber(Math.abs(x)), decimals);
    const digits = written(magnitude).padStart(decimals + 1, '0');
    if (decimals === 0)
        return sign + digits;
    const whole = digits.slice(0, digits.length - decimals);
    return `${sign}${whole}.${digits.slice(digits.length - decimals)}`;
}
/**
 * How long `text(x, d)` will be, before a character of it is built.
 *
 * A floor rather than the exact count: a carry off the front adds one digit and
 * a negative adds the sign, and both are caught by the ceiling the built string
 * is checked against. What this is for is the decimal count a script computed,
 * which can ask for a string no engine can hold, and building it to find that
 * out is how an engine runs out of memory instead of reporting that it would
 * have. `str.repeat` measures first for the same reason.
 */
function lengthOf(x, decimals) {
    const before = Math.max(1, spread(canonicalNumber(Math.abs(x)), 0).point);
    return before + decimals + (decimals > 0 ? 1 : 0);
}
/**
 * `toNumber(s)`: a string to a number, absent for anything it does not parse.
 *
 * The grammar is written out rather than handed to the host language's parser,
 * which accepts hexadecimal, infinities and a bare leading point in some
 * languages and not others. Absence rather than zero for text that is not a
 * number, so a script can tell text that is not a number apart from the number
 * zero. The whitespace ignored at either end is `str.trim`'s set and no other.
 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function parseNumber(text) {
    const bare = trimmed(text);
    if (!NUMERIC.test(bare))
        return null;
    const parsed = Number(bare);
    return Number.isFinite(parsed) ? (parsed === 0 ? 0 : parsed) : null;
}
function makeArray(ctx, items) {
    ctx.guard.array(ctx.span, 'the array', items.length);
    return reference(ctx.heap.allocate({ kind: 'array', items }));
}
export const TEXT_ENTRIES = [
    entry('text', 'x', (ctx, args) => ctx.guard.string(ctx.span, spell(ctx, valueAt(args, 0)))),
    entry('text', 'x decimals', (ctx, args) => {
        const x = numberAt(args, 0);
        const decimals = wholeAt(ctx, 'text', 'decimals', args, 1);
        if (x === null || decimals === null)
            return null;
        ctx.guard.chars(ctx.span, lengthOf(x, decimals));
        return ctx.guard.string(ctx.span, fixed(x, decimals));
    }),
    entry('toNumber', 's', (_ctx, args) => {
        const text = stringAt(args, 0);
        return text === null ? null : parseNumber(text);
    }),
    entry('str.length', 's', (_ctx, args) => {
        const text = stringAt(args, 0);
        return text === null ? null : points(text).length;
    }),
    entry('str.upper', 's', (ctx, args) => map(ctx, args, (s) => s.toUpperCase())),
    entry('str.lower', 's', (ctx, args) => map(ctx, args, (s) => s.toLowerCase())),
    entry('str.trim', 's', (ctx, args) => map(ctx, args, trimmed)),
    entry('str.contains', 's part', (_ctx, args) => pair(args, (s, part) => s.includes(part))),
    entry('str.startsWith', 's part', (_ctx, args) => pair(args, (s, part) => s.startsWith(part))),
    entry('str.endsWith', 's part', (_ctx, args) => pair(args, (s, part) => s.endsWith(part))),
    entry('str.indexOf', 's part', (_ctx, args) => pair(args, (s, part) => {
        const at = s.indexOf(part);
        return at < 0 ? -1 : points(s.slice(0, at)).length;
    })),
    entry('str.substring', 's from to', (ctx, args) => {
        const text = stringAt(args, 0);
        const from = wholeAt(ctx, 'str.substring', 'from', args, 1);
        if (text === null || from === null)
            return null;
        const all = points(text);
        const to = args[2] === null || args[2] === undefined
            ? all.length
            : wholeAt(ctx, 'str.substring', 'to', args, 2);
        if (to === null)
            return null;
        return ctx.guard.string(ctx.span, all.slice(from, to).join(''));
    }),
    entry('str.replace', 's find with', (ctx, args) => triple(ctx, args, (s, find, into) => s.replace(find, () => into))),
    entry('str.replaceAll', 's find with', (ctx, args) => triple(ctx, args, (s, find, into) => s.split(find).join(into))),
    entry('str.split', 's separator', (ctx, args) => {
        const text = stringAt(args, 0);
        const separator = stringAt(args, 1);
        if (text === null || separator === null)
            return null;
        const parts = text.split(separator);
        return makeArray(ctx, parts);
    }),
    entry('str.join', 'parts separator', (ctx, args) => {
        const handle = refAt(args, 0);
        const separator = stringAt(args, 1);
        if (handle === null || separator === null)
            return null;
        const object = ctx.heap.get(handle.id);
        if (object === undefined || object.kind !== 'array')
            return null;
        const pieces = [];
        for (const item of object.items)
            pieces.push(spell(ctx, item));
        return ctx.guard.string(ctx.span, pieces.join(separator));
    }),
    entry('str.padLeft', 's width fill', (ctx, args) => pad(ctx, args, true)),
    entry('str.padRight', 's width fill', (ctx, args) => pad(ctx, args, false)),
    entry('str.repeat', 's n', (ctx, args) => {
        const text = stringAt(args, 0);
        const count = wholeAt(ctx, 'str.repeat', 'n', args, 1);
        if (text === null || count === null)
            return null;
        // Measured before it is built. A length times a count is where the string
        // ceiling is actually reached, and building the string first to measure it
        // is how an engine runs out of memory instead of reporting that it would.
        ctx.guard.chars(ctx.span, points(text).length * count);
        return text.repeat(count);
    }),
];
function map(ctx, args, of) {
    const text = stringAt(args, 0);
    return text === null ? null : ctx.guard.string(ctx.span, of(text));
}
function pair(args, of) {
    const text = stringAt(args, 0);
    const part = stringAt(args, 1);
    return text === null || part === null ? null : of(text, part);
}
function triple(ctx, args, of) {
    const text = stringAt(args, 0);
    const a = stringAt(args, 1);
    const b = stringAt(args, 2);
    if (text === null || a === null || b === null)
        return null;
    return ctx.guard.string(ctx.span, of(text, a, b));
}
function pad(ctx, args, left) {
    const text = stringAt(args, 0);
    const width = wholeAt(ctx, left ? 'str.padLeft' : 'str.padRight', 'width', args, 1);
    const fill = stringAt(args, 2) ?? ' ';
    if (text === null || width === null || fill === '')
        return text === null ? null : text;
    const all = points(text);
    if (all.length >= width)
        return text;
    const filler = points(fill);
    const needed = width - all.length;
    const padding = [];
    for (let i = 0; i < needed; i += 1)
        padding.push(filler[i % filler.length] ?? ' ');
    const joined = padding.join('');
    return ctx.guard.string(ctx.span, left ? joined + text : text + joined);
}
//# sourceMappingURL=text.js.map