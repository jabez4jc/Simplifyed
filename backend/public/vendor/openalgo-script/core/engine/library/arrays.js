import { isNumber, reference, valuesEqual } from '../values/index.js';
import { entry, refAt, stringAt, valueAt, wholeAt } from './binding.js';
import { compareStrings } from './code-points.js';
import { result } from '../../stdlib/index.js';
/** The array a handle names, or nothing when the handle is absent or stale. */
function held(ctx, args, index) {
    const handle = refAt(args, index);
    if (handle === null)
        return undefined;
    const object = ctx.heap.get(handle.id);
    return object !== undefined && object.kind === 'array' ? object : undefined;
}
/** Announces a change before making it, so the bar's undo journal has the old one. */
function changing(ctx, args, index) {
    const handle = refAt(args, index);
    if (handle === null)
        return undefined;
    const object = ctx.heap.get(handle.id);
    if (object === undefined || object.kind !== 'array')
        return undefined;
    ctx.heap.touch(handle.id);
    return object;
}
function grew(ctx, array, args, by) {
    ctx.heap.countElements(by);
    ctx.guard.array(ctx.span, ctx.nameOf(valueAt(args, 0)), array.items.length);
}
/** The index an array call was given, checked against the array's own extent. */
function within(ctx, args, at, array, limit) {
    const index = args[at];
    if (index === undefined || index === null || !isNumber(index) || !Number.isInteger(index) ||
        index < 0 || index >= limit) {
        ctx.guard.badIndex(ctx.span, ctx.nameOf(valueAt(args, 0)), index === undefined || index === null ? 'none' : String(index), array.items.length);
    }
    return index;
}
/**
 * The order `sort` uses, written down so two engines cannot differ.
 *
 * Two strings order by code point (`language.md` 9.3), which is not the order
 * the host's `<` gives once a string holds a symbol outside the basic plane.
 */
function rank(a, b) {
    if (a === null)
        return b === null ? 0 : 1;
    if (b === null)
        return -1;
    if (typeof a === 'number' && typeof b === 'number')
        return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string')
        return compareStrings(a, b);
    if (typeof a === 'boolean' && typeof b === 'boolean')
        return a === b ? 0 : a ? 1 : -1;
    return 0;
}
function numbersOf(array) {
    return array.items.map((item) => (isNumber(item) ? item : null));
}
/**
 * The five reductions over an array's contents.
 *
 * These are the array forms of names the numeric library also carries over a
 * series, and they are written here rather than called through because the
 * library's forms take a length and a lookback and these take an extent the
 * script chose. The accumulation order is the same one: index order, oldest
 * first, summed fresh.
 *
 * An absent element makes the answer absent rather than being skipped, on the
 * same rule as every lookback: a mean over an array with a hole in it is a mean
 * over fewer values than the script thinks it has. `sum` of an empty array is
 * zero, and `avg`, `min`, `max` and `stdev` of one are absent, because there is
 * a sum of nothing and there is no mean of nothing.
 */
function reduce(array) {
    const values = numbersOf(array);
    for (const value of values)
        if (value === null)
            return null;
    return values;
}
function sumOf(array) {
    const values = reduce(array);
    if (values === null)
        return null;
    let total = 0;
    for (const value of values)
        total += value;
    return result(total);
}
function extremeOf(array, wantHigh) {
    const values = reduce(array);
    if (values === null || values.length === 0)
        return null;
    let best = values[0];
    for (const value of values) {
        const one = value;
        if (wantHigh ? one > best : one < best)
            best = one;
    }
    return result(best);
}
function meanOf(array) {
    const values = reduce(array);
    if (values === null || values.length === 0)
        return null;
    const total = sumOf(array);
    return total === null ? null : result(total / values.length);
}
function spreadOf(array) {
    const values = reduce(array);
    const mean = meanOf(array);
    if (values === null || mean === null)
        return null;
    let squares = 0;
    for (const value of values) {
        const deviation = value - mean;
        squares += deviation * deviation;
    }
    const variance = result(squares / values.length);
    return variance === null || variance < 0 ? null : result(Math.sqrt(variance));
}
function newArray(ctx, items) {
    ctx.guard.array(ctx.span, 'the array', items.length);
    return reference(ctx.heap.allocate({ kind: 'array', items }));
}
export const ARRAY_ENTRIES = [
    entry('size', 'arr', (ctx, args) => held(ctx, args, 0)?.items.length ?? null),
    entry('element', 'arr i', (ctx, args) => {
        const array = held(ctx, args, 0);
        if (array === undefined)
            return null;
        return array.items[within(ctx, args, 1, array, array.items.length)] ?? null;
    }),
    entry('set', 'arr i v', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        array.items[within(ctx, args, 1, array, array.items.length)] = valueAt(args, 2);
        return null;
    }),
    entry('push', 'arr v', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        array.items.push(valueAt(args, 1));
        grew(ctx, array, args, 1);
        return null;
    }),
    entry('pop', 'arr', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        if (array.items.length === 0) {
            ctx.guard.badIndex(ctx.span, ctx.nameOf(valueAt(args, 0)), 'the last element', 0);
        }
        const value = array.items.pop() ?? null;
        ctx.heap.countElements(-1);
        return value;
    }),
    entry('shift', 'arr', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        if (array.items.length === 0) {
            ctx.guard.badIndex(ctx.span, ctx.nameOf(valueAt(args, 0)), 'the first element', 0);
        }
        const value = array.items.shift() ?? null;
        ctx.heap.countElements(-1);
        return value;
    }),
    entry('unshift', 'arr v', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        array.items.unshift(valueAt(args, 1));
        grew(ctx, array, args, 1);
        return null;
    }),
    // Insert accepts the position one past the end, which is an append: a loop
    // that inserts at `size(arr)` is how a script builds a list in order, and
    // refusing it would make the last element a special case.
    entry('insert', 'arr i v', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        const at = within(ctx, args, 1, array, array.items.length + 1);
        array.items.splice(at, 0, valueAt(args, 2));
        grew(ctx, array, args, 1);
        return null;
    }),
    entry('remove', 'arr i', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        const at = within(ctx, args, 1, array, array.items.length);
        const removed = array.items.splice(at, 1)[0] ?? null;
        ctx.heap.countElements(-1);
        return removed;
    }),
    entry('slice', 'arr from to', (ctx, args) => {
        const array = held(ctx, args, 0);
        if (array === undefined)
            return null;
        const from = wholeAt(ctx, 'slice', 'from', args, 1);
        const to = wholeAt(ctx, 'slice', 'to', args, 2);
        if (from === null || to === null)
            return null;
        return newArray(ctx, array.items.slice(from, to));
    }),
    entry('copy', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : newArray(ctx, [...array.items]);
    }),
    entry('indexOf', 'arr v', (ctx, args) => {
        const array = held(ctx, args, 0);
        if (array === undefined)
            return null;
        const wanted = valueAt(args, 1);
        for (let i = 0; i < array.items.length; i += 1) {
            if (valuesEqual(array.items[i] ?? null, wanted))
                return i;
        }
        return -1;
    }),
    entry('arrayEqual', 'a b', (ctx, args) => {
        const a = held(ctx, args, 0);
        const b = held(ctx, args, 1);
        if (a === undefined || b === undefined)
            return null;
        if (a.items.length !== b.items.length)
            return false;
        for (let i = 0; i < a.items.length; i += 1) {
            if (!valuesEqual(a.items[i] ?? null, b.items[i] ?? null))
                return false;
        }
        return true;
    }),
    entry('sort', 'arr order', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        const descending = stringAt(args, 1) === 'desc';
        array.items.sort((a, b) => (descending ? rank(b, a) : rank(a, b)));
        return null;
    }),
    entry('reverse', 'arr', (ctx, args) => {
        const array = changing(ctx, args, 0);
        if (array === undefined)
            return null;
        array.items.reverse();
        return null;
    }),
    entry('sum', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : sumOf(array);
    }),
    entry('avg', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : meanOf(array);
    }),
    entry('min', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : extremeOf(array, false);
    }),
    entry('max', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : extremeOf(array, true);
    }),
    entry('stdev', 'arr', (ctx, args) => {
        const array = held(ctx, args, 0);
        return array === undefined ? null : spreadOf(array);
    }),
];
/**
 * Emptying an array, which shares its name and its arity with emptying a grid.
 *
 * `stdlib.md` 14.3 gives `clear` two signatures, and both take one argument, so
 * the compiled program's `lib.functions` carries one entry for the pair and the
 * engine is the place that tells them apart. It does it by asking the heap what
 * the handle points at, which is the only run-time dispatch in the whole
 * library and is here because the format leaves it nowhere else to be.
 */
export function clearArray(ctx, args) {
    const array = changing(ctx, args, 0);
    if (array === undefined)
        return false;
    ctx.heap.countElements(-array.items.length);
    array.items.length = 0;
    return true;
}
//# sourceMappingURL=arrays.js.map