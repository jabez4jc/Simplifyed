import { LOOP_BUDGET, STRATEGY_DEFAULTS, STRATEGY_OPTIONS, STUDY_DEFAULTS, } from './defaults.js';
import { fieldOf } from './values.js';
function optionField(e, options, name, defaults) {
    const written = options.get(name);
    if (written === undefined)
        return fieldOf(defaults[name]);
    const value = e.fold(written);
    if (value !== undefined)
        return fieldOf(value);
    e.gap('a declaration option written as an expression over an input cannot be carried: a field ' +
        'holds a value or a reference to one input, and this is neither', 'compiled-program.md 2.3, against language.md 13.2', written.span, true);
    return null;
}
export function buildMeta(e) {
    const declaration = e.checked.declaration;
    const options = declaration?.options ?? new Map();
    const title = optionField(e, options, 'title', {});
    const base = {
        kind: declaration?.form ?? 'study',
        title,
        // `short` falls back to `title`, which is the one default that is another
        // option's value rather than a constant (language.md 13.2).
        short: options.has('short') ? optionField(e, options, 'short', {}) : title,
        overlay: optionField(e, options, 'overlay', STUDY_DEFAULTS),
        precision: optionField(e, options, 'precision', STUDY_DEFAULTS),
        format: optionField(e, options, 'format', STUDY_DEFAULTS),
        range: optionField(e, options, 'range', STUDY_DEFAULTS),
        scale: optionField(e, options, 'scale', STUDY_DEFAULTS),
        group: optionField(e, options, 'group', STUDY_DEFAULTS),
        onUnconfirmed: optionField(e, options, 'onUnconfirmed', STUDY_DEFAULTS),
    };
    if (base.kind !== 'strategy')
        return base;
    const strategy = {};
    for (const option of STRATEGY_OPTIONS) {
        strategy[option] = optionField(e, options, option, STRATEGY_DEFAULTS);
    }
    return { ...base, strategy: strategy };
}
/**
 * `limits()`, whose values are literal numbers rather than compile-time
 * constants.
 *
 * The host is asked whether it will run them before the program is loaded, and
 * an `input()` is not resolved that early (`language.md` 10.7). A host that
 * will not spend what a program asks for refuses at load with OS5003 and must
 * not silently cap it.
 */
export function buildLimits(e) {
    const line = e.checked.script.items.find((item) => item.kind === 'limitsLine');
    if (line === undefined || line.kind !== 'limitsLine') {
        return { loops: LOOP_BUDGET, history: null };
    }
    return {
        loops: literalOption(e, line.args, 'loops', 0) ?? LOOP_BUDGET,
        history: literalOption(e, line.args, 'history', 1) ?? null,
    };
}
function literalOption(e, args, name, position) {
    const labelled = args.find((one) => one.label?.text === name);
    const positional = args.filter((one) => one.label === undefined)[position];
    const chosen = labelled ?? positional;
    if (chosen === undefined)
        return undefined;
    const value = e.fold(chosen.value);
    return value !== undefined && value.kind === 'number' ? value.value : undefined;
}
//# sourceMappingURL=meta.js.map