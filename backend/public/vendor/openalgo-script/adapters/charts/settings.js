import { checkSetting, constantValue } from '../../core/engine/index.js';
import { cssColour, isColourValue, parseColour } from './colours.js';
/** The eight series a `"source"` input may select, in the order 2.6 lists them. */
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
/** One settings row per declared input, in source order. */
export function inputRows(program) {
    const rows = [];
    for (const declared of program.inputs)
        rows.push(rowFor(declared));
    return rows;
}
/**
 * What the engine is handed as the host's settings.
 *
 * Only the declared keys travel. A chart's settings object also carries the
 * generated per-plot appearance keys and the chart's timezone, and an engine
 * given those would have nothing to do with them; leaving them out keeps the
 * two vocabularies from having to agree on anything but the input keys.
 */
export function engineSettings(program, settings) {
    const out = {};
    for (const declared of program.inputs) {
        const supplied = storedValue(declared, settings);
        if (supplied !== undefined)
            out[declared.key] = supplied;
    }
    return out;
}
/** The value each declared input currently holds, for a declaration field. */
export function lookupFor(program, settings) {
    return (key) => {
        const declared = program.inputs.find((one) => one.key === key);
        if (declared === undefined)
            return null;
        return effectiveValue(declared, settings);
    };
}
/**
 * A comparable spelling of every declared input's value.
 *
 * The incremental path is only valid while the engine it holds was loaded from
 * the same settings, and comparing the two spellings is cheaper and safer than
 * trusting a chart to have told us that a settings change happened.
 *
 * **It spells what the engine is handed, not what the declared shape shows.**
 * Those part company the moment a stored value is one the engine refuses: every
 * refused value shows the same declared default, so a signature taken from the
 * shape would read a change from a setting that runs to one that cannot as no
 * change at all, keep the held engine and go on drawing the old numbers instead
 * of reporting OS6019. The kind is spelled beside the value for the same
 * reason: a stored `7` and a stored `"7"` are one quotation mark apart, and one
 * of them is refused.
 */
export function signatureOf(program, settings) {
    const parts = [];
    for (const declared of program.inputs) {
        parts.push(`${declared.key}=${spellStored(storedValue(declared, settings))}`);
    }
    return parts.join('\u0000');
}
/** The declared default, as the value model holds it. */
export function defaultValue(declared) {
    return constantValue(declared.default);
}
function rowFor(declared) {
    const held = defaultValue(declared);
    const label = declared.label;
    const key = declared.key;
    const extra = {
        ...(declared.group === '' ? {} : { group: declared.group }),
        ...(declared.tooltip === null ? {} : { tooltip: declared.tooltip }),
    };
    // A choice is a choice whatever the type of its members. The compiled kind is
    // `"select"` only where the values are strings, so a script that constrained a
    // length to two numbers arrives as a number carrying options, and a spinner
    // would offer every value between them: the engine validates a number against
    // its bounds and not against its options, so nothing downstream would refuse
    // the third value a user typed. The declared choices are the control.
    const options = declared.options ?? [];
    if (options.length > 0) {
        return {
            key,
            type: 'select',
            label,
            default: spell(held),
            options: options.map((one) => {
                const text = spell(constantValue(one));
                return { label: text, value: text };
            }),
            ...extra,
        };
    }
    switch (declared.kind) {
        case 'number':
            return {
                key,
                type: 'number',
                label,
                default: typeof held === 'number' ? held : 0,
                ...(declared.min === null ? {} : { min: declared.min }),
                ...(declared.max === null ? {} : { max: declared.max }),
                ...(declared.step === null ? {} : { step: declared.step }),
                ...extra,
            };
        case 'bool':
            return { key, type: 'boolean', label, default: held === true, ...extra };
        case 'color':
            return {
                key,
                type: 'color',
                label,
                default: isColourValue(held) ? cssColour(held) : 'rgba(0, 0, 0, 1)',
                ...extra,
            };
        case 'source':
            return {
                key,
                type: 'source',
                label,
                default: typeof held === 'string' && SOURCES.includes(held) ? held : 'close',
                ...extra,
            };
        case 'interval':
            return { key, type: 'interval', label, default: typeof held === 'string' ? held : '', ...extra };
        case 'time':
            return { key, type: 'time', label, default: typeof held === 'string' ? held : '', ...extra };
        default:
            return { key, type: 'text', label, default: typeof held === 'string' ? held : '', ...extra };
    }
}
/** What the host stored for this input, converted, or nothing when it stored none. */
function storedValue(declared, settings) {
    if (!Object.prototype.hasOwnProperty.call(settings, declared.key))
        return undefined;
    const supplied = settings[declared.key];
    if (supplied === undefined)
        return undefined;
    if (declared.kind === 'color' && typeof supplied === 'string') {
        // A swatch has no alpha channel, so a stored colour that states none keeps
        // the alpha the script declared. See `colours.ts`.
        const held = defaultValue(declared);
        const parsed = parseColour(supplied, isColourValue(held) ? held.a : 1);
        return parsed ?? supplied;
    }
    if (declared.options !== null && typeof supplied === 'string') {
        // The control's values are strings even where the declared choices are not,
        // so a stored choice is matched on its own spelling and the engine is given
        // the option the script wrote rather than the text of it.
        const chosen = optionFor(declared.options, supplied);
        return chosen === undefined ? supplied : chosen;
    }
    return supplied;
}
/**
 * The effective value: the host's where the engine will run with it.
 *
 * The question is `checkSetting`'s, so there is no second list of types and
 * bounds here to disagree with the first. This file decides only what to do
 * with the answer, and the module's own paragraph says why a refused value
 * reads as the declared default rather than as itself.
 *
 * One answer is narrowed and it is narrowed on purpose: a `"time"` input's
 * stored string is read by the host's own conversion, which `run.ts` has and
 * this has not, so a string is taken here and the load decides it.
 */
function effectiveValue(declared, settings) {
    const stored = storedValue(declared, settings);
    if (stored === undefined)
        return defaultValue(declared);
    const checked = checkSetting(declared, stored);
    return checked.ok ? checked.value : defaultValue(declared);
}
/** The declared option a stored string names, matched on its own spelling. */
function optionFor(options, supplied) {
    for (const option of options) {
        const value = constantValue(option);
        if (spell(value) === supplied)
            return value;
    }
    return undefined;
}
/**
 * A stored value as the signature spells it, kind and all.
 *
 * Two stored values that spell one string are a settings change the incremental
 * path does not notice, and a dialog stores numbers and text that look alike
 * written out while the engine takes one and refuses the other. Every value of
 * another kind spells the same word, which costs nothing: none of them can be
 * behind a held engine, because the load that would have held one refused it.
 */
function spellStored(value) {
    if (value === undefined)
        return 'unset';
    if (value === null)
        return 'none';
    if (isColourValue(value))
        return `color ${cssColour(value)}`;
    if (typeof value === 'number')
        return `number ${String(value)}`;
    if (typeof value === 'boolean')
        return `bool ${String(value)}`;
    if (typeof value === 'string')
        return `text ${value}`;
    return 'of another kind';
}
/** A value as a settings control spells it. */
function spell(value) {
    if (value === null)
        return '';
    if (isColourValue(value))
        return cssColour(value);
    if (typeof value === 'object')
        return '';
    return String(value);
}
//# sourceMappingURL=settings.js.map