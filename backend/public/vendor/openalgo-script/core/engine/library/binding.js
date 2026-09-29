import { isColour, isNumber, isRef, isString, reference } from '../values/index.js';
/**
 * Declares one entry.
 *
 * The parameter names are written as one space separated string, because that
 * is how `stdlib.md`'s tables show a signature and the two can then be compared
 * by eye without translating one of them first.
 */
export function entry(name, params, call, options = {}) {
    const list = params === '' ? [] : params.split(' ');
    return {
        name,
        arity: list.length,
        state: options.state === true,
        effect: options.effect ?? 'none',
        params: list,
        whole: options.whole ?? [],
        call,
    };
}
/**
 * An entry whose work happens at step 9, so the call itself produces absence.
 *
 * **An order call takes one argument more than the language surface shows**,
 * and it is appended here rather than written into each of the nine signatures,
 * so that the count the program records and the count this table expects cannot
 * be given different answers. It is the names of the arguments the script wrote,
 * in parameter order, and `compiled-program.md` 4.10 says why an order call
 * needs it: two of its defaults are absence itself, so an argument left out and
 * an argument written that came out absent arrive as the same value, and
 * `language.md` 6.8 gives those opposite meanings.
 */
export function deferred(name, params, effect) {
    const all = effect === 'order' ? `${params} written`.trim() : params;
    return entry(name, all, () => null, { effect });
}
/**
 * The several numbers a multi-value call returns, as the array `stdlib.md`
 * sections 2.3, 5 and 6 say it hands back.
 *
 * A fresh reference on every bar, because the language's own way of returning a
 * trio is an array and an array is a heap object. The array never changes
 * length and is never absent: each element carries its own warmup and is absent
 * until it is reached, so an index is never out of range at the left edge of a
 * chart and in range everywhere else.
 */
export function multi(ctx, items) {
    return reference(ctx.heap.allocate({ kind: 'array', items: [...items] }));
}
export function numberAt(args, index) {
    const value = args[index];
    return value !== undefined && isNumber(value) ? value : null;
}
export function stringAt(args, index) {
    const value = args[index];
    return value !== undefined && isString(value) ? value : null;
}
export function boolAt(args, index) {
    const value = args[index];
    return typeof value === 'boolean' ? value : null;
}
export function colourAt(args, index) {
    const value = args[index];
    return value !== undefined && isColour(value) ? value : null;
}
export function refAt(args, index) {
    const value = args[index];
    return value !== undefined && isRef(value) ? value : null;
}
export function valueAt(args, index) {
    return args[index] ?? null;
}
/**
 * A length argument, checked against its contract.
 *
 * A length that is present and is not a whole number of one or more is a bug in
 * the script and is OS4003, named against the parameter that took it. A length
 * that is absent is left to the function, which returns absence: the argument
 * arrived during another value's warmup, and stopping the study would turn a
 * gap into an error.
 */
export function lengthAt(ctx, name, param, args, index) {
    return checkedWhole(ctx, name, param, args[index], 1);
}
/** A whole number of zero or more, for a digit count or an index. */
export function wholeAt(ctx, name, param, args, index) {
    return checkedWhole(ctx, name, param, args[index], 0);
}
function checkedWhole(ctx, name, param, value, least) {
    if (value === undefined || value === null)
        return null;
    if (!isNumber(value) || !Number.isInteger(value) || value < least) {
        ctx.guard.badArgument(ctx.span, name, param, describe(value));
    }
    return value;
}
/** A value as a diagnostic has to print it. */
export function describe(value) {
    if (value === null)
        return 'none';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value.tag === 'color')
        return `a colour`;
    return 'an object';
}
//# sourceMappingURL=binding.js.map