import { isBarField } from './bars.js';
import { NO_POSITION, failure } from './errors.js';
/** The eight built-in series a `"source"` input may select, 2.6. */
const SOURCES = [
    'open',
    'high',
    'low',
    'close',
    'hl2',
    'hlc3',
    'ohlc4',
    'volume',
];
/** The value a constant pool entry denotes. */
export function constantValue(entry) {
    switch (entry[0]) {
        case 'z':
            return null;
        case 'b':
        case 'n':
        case 's':
            return entry[1];
        default:
            return { tag: 'color', r: entry[1][0], g: entry[1][1], b: entry[1][2], a: entry[1][3] };
    }
}
export function resolveInputs(program, settings, resolveTime) {
    const inputs = [];
    for (const declared of program.inputs) {
        const resolved = resolveOne(declared, settings, resolveTime);
        if ('diagnostic' in resolved)
            return { ok: false, diagnostic: resolved.diagnostic };
        inputs.push(resolved.input);
    }
    return { ok: true, inputs };
}
function refuse(key, value, validation) {
    return {
        diagnostic: failure('OS6019', NO_POSITION, { value: describe(value), key, validation }),
    };
}
function resolveOne(declared, settings, resolveTime) {
    const supplied = Object.prototype.hasOwnProperty.call(settings, declared.key)
        ? settings[declared.key]
        : undefined;
    const fallback = constantValue(declared.default);
    // A source and a time are checked even where the host stored nothing, because
    // each declares its value as text that this engine still has to read. Every
    // other kind takes its declared default unexamined, which is this engine's
    // behaviour as it stands: a default is written in the source and validation
    // here is about a value that arrived from outside it.
    const askAnyway = declared.kind === 'source' || declared.kind === 'time';
    if (supplied === undefined && !askAnyway) {
        return { input: { key: declared.key, slot: declared.slot, field: undefined, value: fallback } };
    }
    const held = supplied === undefined ? fallback : supplied;
    const checked = checkSetting(declared, held, resolveTime);
    if (!checked.ok)
        return refuse(declared.key, held, checked.refusal);
    return {
        input: {
            key: declared.key,
            slot: declared.slot,
            field: checked.field,
            value: checked.value,
        },
    };
}
/**
 * What the engine will run with for one stored value, or the rule it breaks.
 *
 * **This is exported because the question is asked outside the engine as well.**
 * A chart builds the settings dialog and the declared shape of a study before
 * anything is loaded, so it has to know what a stored value is worth before the
 * run that would refuse it exists. A second copy of these rules in an adapter
 * would be the same fact written in two files, and the two would answer
 * differently the first time either was edited: the chart adapter had its own
 * idea of an unusable value, and handed out a precision an input's own `max`
 * forbade while the engine beside it refused the same map with OS6019.
 *
 * `resolveTime` is optional, and leaving it out narrows exactly one answer. A
 * `"time"` input's string is read by the host's own conversion, which is the
 * host's to supply, so a caller with none takes a string on trust and leaves
 * that half to the load. Every other kind is decided here.
 */
export function checkSetting(declared, supplied, resolveTime) {
    if (declared.kind === 'source') {
        if (typeof supplied !== 'string' || !SOURCES.includes(supplied)) {
            return { ok: false, refusal: `a source names one of ${SOURCES.join(', ')}` };
        }
        if (!isBarField(supplied)) {
            return { ok: false, refusal: 'this engine has no bar field of that name' };
        }
        return { ok: true, value: null, field: supplied };
    }
    if (declared.kind === 'time') {
        const unreadable = 'a time is a timestamp or a date and time the host can read';
        if (typeof supplied === 'number')
            return { ok: true, value: supplied, field: undefined };
        if (typeof supplied !== 'string')
            return { ok: false, refusal: unreadable };
        if (resolveTime === undefined)
            return { ok: true, value: supplied, field: undefined };
        const time = resolveTime(supplied);
        if (time === null)
            return { ok: false, refusal: unreadable };
        return { ok: true, value: time, field: undefined };
    }
    const wrong = validate(declared, supplied);
    if (wrong !== undefined)
        return { ok: false, refusal: wrong };
    return { ok: true, value: supplied, field: undefined };
}
/** What rule the host's value broke, or nothing when it passes. */
function validate(declared, supplied) {
    switch (declared.kind) {
        case 'number': {
            if (typeof supplied !== 'number' || !Number.isFinite(supplied)) {
                return 'this input takes a number';
            }
            if (declared.min !== null && supplied < declared.min) {
                return `the minimum is ${declared.min}`;
            }
            if (declared.max !== null && supplied > declared.max) {
                return `the maximum is ${declared.max}`;
            }
            return undefined;
        }
        case 'bool':
            return typeof supplied === 'boolean' ? undefined : 'this input takes true or false';
        case 'color':
            return isColourValue(supplied) ? undefined : 'this input takes a colour';
        case 'select': {
            if (typeof supplied !== 'string')
                return 'this input takes one of its listed values';
            const allowed = (declared.options ?? []).map((one) => constantValue(one));
            if (!allowed.includes(supplied)) {
                return `the choices are ${allowed.map((one) => String(one)).join(', ')}`;
            }
            return undefined;
        }
        default:
            return typeof supplied === 'string' ? undefined : 'this input takes a string';
    }
}
function isColourValue(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const held = value;
    return (held['tag'] === 'color' &&
        typeof held['r'] === 'number' &&
        typeof held['g'] === 'number' &&
        typeof held['b'] === 'number' &&
        typeof held['a'] === 'number');
}
/**
 * A declaration field with its `{ "input": key }` reference substituted.
 *
 * Every field of `meta`, of `meta.strategy` and of every declaration in
 * `outputs` may hold the reference, and it is gone before bar 0.
 */
export function fieldValue(field, inputs) {
    if (field === null)
        return null;
    if (typeof field === 'object' && !Array.isArray(field)) {
        const key = field.input;
        const found = inputs.find((one) => one.key === key);
        return found === undefined ? null : found.value;
    }
    if (Array.isArray(field)) {
        const [r, g, b, a] = field;
        if (r === undefined || g === undefined || b === undefined || a === undefined)
            return null;
        return { tag: 'color', r, g, b, a };
    }
    return field;
}
/**
 * A date and time read as if it were UTC.
 *
 * **This is a stand-in.** `stdlib.md` 12.1 reads every calendar field in the
 * chart's timezone, which is an IANA zone name the host states, and an engine
 * that has not been given one cannot apply it. A host with a zone supplies its
 * own resolver; this one is what a test and a host with no zone get, and it is
 * deterministic, which is the property that matters most here.
 */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
export function utcTime(text) {
    const parsed = STAMP.exec(text.trim());
    if (parsed === null)
        return null;
    const at = (index) => Number(parsed[index] ?? '0');
    const value = Date.UTC(at(1), at(2) - 1, at(3), at(4), at(5), at(6));
    return Number.isFinite(value) ? value : null;
}
function describe(value) {
    if (value === undefined || value === null)
        return 'none';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return 'a value of another type';
}
//# sourceMappingURL=inputs.js.map