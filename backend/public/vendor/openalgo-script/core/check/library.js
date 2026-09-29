import { BOOL, COLOR, NONE, NOTHING, NUMBER, STRING, UNKNOWN, arrayOf, handleType, objectType, objectsType, seriesOf, } from './types.js';
export function wholeRange(min, max) {
    const text = min !== undefined && max !== undefined
        ? `${min} to ${max}`
        : min !== undefined
            ? `${min} or more`
            : max !== undefined
                ? `${max} or less`
                : 'with no fractional part';
    return { text, min, max };
}
const OBJECT_NAMES = ['line', 'label', 'box', 'polyline', 'table'];
const HANDLE_NAMES = ['plot', 'fill', 'level'];
/**
 * A type as the signature strings spell it.
 *
 * `any` and the single letters are not types of the language. `any` is a
 * parameter that takes whatever it is given, which is what `isNone` and `text`
 * want. A single letter is a stand-in carried from one parameter to another, so
 * that `push(arr, v)` can say that `v` is whatever `arr` holds and `orElse`
 * can say it gives back what it was given. Both are resolved at the call site
 * and neither ever reaches a name's type.
 *
 * `line | box` is not either of those and is not a general union: it is the set
 * of object kinds one parameter accepts, which is what a `draw` setter takes,
 * and it is checked like any other declared type. `any` used to stand there,
 * and an `any` that means "one of these two" accepts a label and a number as
 * readily, which is the defect it is written to end.
 */
export const ANY = UNKNOWN;
const VARIABLE = /^[A-Z]$/;
function parseType(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('series '))
        return seriesOf(parseType(trimmed.slice(7)));
    if (trimmed.startsWith('array<') && trimmed.endsWith('>')) {
        return arrayOf(parseType(trimmed.slice(6, -1)));
    }
    if (trimmed.includes('|'))
        return parseObjectSet(trimmed);
    switch (trimmed) {
        case 'number':
            return NUMBER;
        case 'string':
            return STRING;
        case 'bool':
            return BOOL;
        case 'color':
            return COLOR;
        case 'none':
            return NONE;
        case 'nothing':
            return NOTHING;
        case 'any':
            return ANY;
        default:
            if (VARIABLE.test(trimmed))
                return { kind: 'variable', name: trimmed };
            if (OBJECT_NAMES.includes(trimmed))
                return objectType(trimmed);
            if (HANDLE_NAMES.includes(trimmed))
                return handleType(trimmed);
            throw new Error(`library signature names no such type: ${trimmed}`);
    }
}
/**
 * `line | box`, as a set of object kinds.
 *
 * Every member has to be an object kind, there have to be two or more of them,
 * and no kind may be written twice: each of those is a signature somebody wrote
 * by hand, and a set that quietly accepted a misspelling would be a parameter
 * that accepts less than the specification says while reading as though it
 * accepts it.
 */
function parseObjectSet(text) {
    const kinds = text.split('|').map((one) => one.trim());
    const known = kinds.every((one) => OBJECT_NAMES.includes(one));
    const distinct = new Set(kinds).size === kinds.length;
    if (!known || !distinct || kinds.length < 2) {
        throw new Error(`library signature names no such set of object types: ${text}`);
    }
    return objectsType(kinds);
}
/** Split on commas that are not inside angle brackets. */
function splitParameters(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '<')
            depth += 1;
        else if (ch === '>')
            depth -= 1;
        else if (ch === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
/**
 * One entry, from `name(param: type, optional?: type) -> result`.
 *
 * A name with no bracket is a value a script reads bare, such as `close` or
 * `bar.index`. A `?` after a parameter name means the library gives it a
 * default, and `= value` after the type says what that default is, written the
 * way `stdlib.md`'s tables write it so the two can still be compared by eye.
 * The text is carried, never interpreted here: the emitter turns it into a
 * value, because that is where a default belongs (4.10).
 */
export function entry(signature, options = {}) {
    const arrow = signature.indexOf('->');
    if (arrow < 0)
        throw new Error(`library signature has no result type: ${signature}`);
    const head = signature.slice(0, arrow).trim();
    const returns = parseType(signature.slice(arrow + 2));
    const open = head.indexOf('(');
    const callable = open >= 0;
    const name = callable ? head.slice(0, open).trim() : head;
    const parameters = [];
    if (callable) {
        if (!head.endsWith(')'))
            throw new Error(`library signature is not closed: ${signature}`);
        for (const part of splitParameters(head.slice(open + 1, -1))) {
            const colon = part.indexOf(':');
            if (colon < 0)
                throw new Error(`library parameter has no type: ${part}`);
            const written = part.slice(0, colon).trim();
            const optional = written.endsWith('?');
            const rest = part.slice(colon + 1);
            const equals = rest.indexOf('=');
            const defaultText = equals < 0 ? undefined : rest.slice(equals + 1).trim();
            if (defaultText !== undefined && !optional) {
                throw new Error(`library parameter has a default and no question mark: ${part}`);
            }
            // An empty default is a signature that was split somewhere unintended,
            // and it would reach the emitter as a value nobody wrote.
            if (defaultText !== undefined && defaultText.length === 0) {
                throw new Error(`library parameter has an empty default: ${part}`);
            }
            parameters.push({
                name: optional ? written.slice(0, -1) : written,
                type: parseType(equals < 0 ? rest : rest.slice(0, equals)),
                optional,
                defaultText,
            });
        }
    }
    return {
        name,
        callable,
        parameters,
        returns,
        warmup: options.warmup ?? { kind: 'delay', bars: 0 },
        elements: options.elements ?? [],
        stateful: options.stateful === true,
        topLevel: options.topLevel === true,
        strategyOnly: options.strategyOnly === true,
        planned: options.planned === true,
        values: options.values ?? {},
        undeclared: options.undeclared ?? [],
        whole: options.whole ?? {},
        constant: options.constant ?? [],
        written: options.written ?? [],
        conflicts: options.conflicts ?? [],
    };
}
/** `bar `len - 1`` and its relatives, the commonest warmup shape in the library. */
export function fromLength(param, add, scale = 1) {
    return { kind: 'params', params: [param], scale, add, exact: true };
}
/** A sum of lengths, as `bar `len + smoothK - 2`` and its relatives state it. */
export function fromLengths(params, add) {
    return { kind: 'params', params, scale: 1, add, exact: true };
}
/** A warmup this module bounds below rather than reproducing the formula for. */
export function atLeastLength(params, add = 0) {
    return { kind: 'params', params, scale: 1, add, exact: false };
}
export const DELAY_ZERO = { kind: 'delay', bars: 0 };
export const TOTAL = { kind: 'total' };
export const DATA_DRIVEN = { kind: 'data' };
export function delayBars(bars) {
    return { kind: 'delay', bars };
}
export function indexOf(entries) {
    const index = new Map();
    for (const one of entries) {
        const existing = index.get(one.name);
        if (existing === undefined)
            index.set(one.name, [one]);
        else
            existing.push(one);
    }
    return index;
}
//# sourceMappingURL=library.js.map