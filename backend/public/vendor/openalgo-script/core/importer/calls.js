/**
 * Calls, written out as OpenScript text.
 *
 * A call to a function the script declares keeps its arguments, with a named
 * argument's label following the parameter's new spelling where it was renamed.
 * A call to a built-in is translated from its row in the table, one argument to
 * one argument where they line up, and by a translator of its own where they do
 * not: the highest and lowest of a window that default their source, a
 * deviation whose `biased` flag is the negation of OpenScript's `sample`, a
 * true range whose absent first bar is a flag, and the handful of conversions
 * that are an expression rather than a call in OpenScript.
 *
 * A call that draws or trades is a statement, not a value, and its translator
 * lives with the other statements; used as a value it is refused.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { canonicalNumber } from '../emit/index.js';
import { levelCall, plotCall, translateInput } from './outputs.js';
import { neverAbsent } from './presence.js';
import { pathOf } from './syntax.js';
import { CALLS } from './table.js';
import { NOTHING, PREC, atom, translate, wrap } from './values.js';
export function bind(call, positional) {
    const byName = new Map();
    const stray = [];
    let position = 0;
    for (const arg of call.args) {
        if (arg.label !== undefined) {
            byName.set(arg.label, arg);
            continue;
        }
        const name = positional[position];
        if (name === undefined)
            stray.push({ arg, name: `argument ${canonicalNumber(position + 1)}` });
        else
            byName.set(name, arg);
        position += 1;
    }
    return { byName, stray };
}
/**
 * Refuses the first argument that is not one of `known`, with OS9006. Returns
 * whether the call may go on.
 */
export function onlyKnown(ctx, path, bound, known) {
    const first = bound.stray[0];
    if (first !== undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(first.arg.at), { argument: first.name, call: path }));
        return false;
    }
    for (const [name, arg] of bound.byName) {
        if (known.includes(name))
            continue;
        ctx.refuse(diagnosticFor('OS9006', ctx.span(arg.at), { argument: name, call: path }));
        return false;
    }
    return true;
}
/** OS9007, once per built-in: its first bars follow OpenScript's own rules. */
export function warmupNote(ctx, at, call, target) {
    ctx.note(diagnosticFor('OS9007', ctx.span(at), { call, target }), `OS9007 ${call}`);
}
/** The translated text of one argument, or undefined where the call left it out. */
export function argText(ctx, bound, name) {
    const arg = bound.byName.get(name);
    return arg === undefined ? undefined : translate(ctx, arg.value).text;
}
/** Arguments by position up to the first one left out, and by name after it. */
function written(texts, labels) {
    const parts = [];
    let gap = false;
    for (let i = 0; i < texts.length; i += 1) {
        const text = texts[i];
        if (text === undefined) {
            gap = true;
            continue;
        }
        if (!gap)
            parts.push(text);
        else {
            const label = labels[i];
            if (label === undefined)
                return undefined;
            parts.push(`${label} = ${text}`);
        }
    }
    return parts;
}
/** A row whose arguments line up one to one, which is most of the table. */
export function generic(ctx, call, row, path) {
    const bound = bind(call, row.params);
    if (!onlyKnown(ctx, path, bound, row.params))
        return NOTHING;
    const parts = written(row.params.map((name) => argText(ctx, bound, name)), row.targets);
    if (parts === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'an argument left out before another', call: path }));
        return NOTHING;
    }
    if (row.difference === 'warmup')
        warmupNote(ctx, call.callee.at, path, row.target);
    return atom(`${row.target}(${parts.join(', ')})`);
}
function userCall(ctx, call, binding) {
    const parts = call.args.map((arg) => {
        const text = translate(ctx, arg.value).text;
        if (arg.label === undefined)
            return text;
        return `${binding.labels?.get(arg.label) ?? arg.label} = ${text}`;
    });
    return atom(`${binding.output}(${parts.join(', ')})`);
}
/** `ta.tr` read as a value, which is the call with `handle_na` false. */
export function trueRangeValue() {
    return { text: 'isNone(close[1]) ? none : trueRange()', prec: PREC.ternary };
}
function trueRangeCall(ctx, call, path) {
    const bound = bind(call, ['handle_na']);
    if (!onlyKnown(ctx, path, bound, ['handle_na']))
        return NOTHING;
    const flag = bound.byName.get('handle_na')?.value;
    if (flag === undefined || (flag.kind === 'bool' && !flag.value))
        return trueRangeValue();
    if (flag.kind === 'bool')
        return atom('trueRange()');
    const handled = translate(ctx, flag);
    return { text: `${wrap(handled, PREC.or)} or not isNone(close[1]) ? trueRange() : none`, prec: PREC.ternary };
}
function extreme(ctx, call, row, path) {
    const one = call.args.length === 1 && call.args[0]?.label === undefined;
    const bound = bind(call, one ? ['length'] : ['source', 'length']);
    if (!onlyKnown(ctx, path, bound, ['source', 'length']))
        return NOTHING;
    const source = argText(ctx, bound, 'source') ?? (row.target === 'highest' ? 'high' : 'low');
    const length = argText(ctx, bound, 'length');
    if (length === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'length', call: path }));
        return NOTHING;
    }
    warmupNote(ctx, call.callee.at, path, row.target);
    return atom(`${row.target}(${source}, ${length})`);
}
function deviation(ctx, call, row, path) {
    const bound = bind(call, row.params);
    if (!onlyKnown(ctx, path, bound, row.params))
        return NOTHING;
    const source = argText(ctx, bound, 'source');
    const length = argText(ctx, bound, 'length');
    if (source === undefined || length === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: source === undefined ? 'source' : 'length', call: path }));
        return NOTHING;
    }
    const biased = bound.byName.get('biased')?.value;
    let sample = '';
    if (biased !== undefined && !(biased.kind === 'bool' && biased.value)) {
        sample = biased.kind === 'bool' ? ', sample = true' : `, sample = not ${wrap(translate(ctx, biased), PREC.unary)}`;
    }
    warmupNote(ctx, call.callee.at, path, row.target);
    return atom(`${row.target}(${source}, ${length}${sample})`);
}
/** A condition handed to a counting built-in, which the source dialect never sees absent. */
function condition(ctx, call, row, path) {
    const bound = bind(call, row.params);
    if (!onlyKnown(ctx, path, bound, row.params))
        return NOTHING;
    const texts = row.params.map((name) => {
        const arg = bound.byName.get(name);
        if (arg === undefined)
            return undefined;
        const text = translate(ctx, arg.value).text;
        return name === 'condition' && !neverAbsent(ctx, arg.value) ? `orElse(${text}, false)` : text;
    });
    const parts = written(texts, row.targets);
    if (parts === undefined || texts[0] === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'condition', call: path }));
        return NOTHING;
    }
    warmupNote(ctx, call.callee.at, path, row.target);
    return atom(`${row.target}(${parts.join(', ')})`);
}
/** `math.max` and `math.min` take any number of arguments; OpenScript's take two. */
function extremes(ctx, call, row, path) {
    const labelled = call.args.find((arg) => arg.label !== undefined);
    if (labelled !== undefined || call.args.length < 2) {
        const at = labelled?.at ?? call.at;
        ctx.refuse(diagnosticFor('OS9006', ctx.span(at), { argument: labelled?.label ?? 'a single argument', call: path }));
        return NOTHING;
    }
    const texts = call.args.map((arg) => translate(ctx, arg.value).text);
    let text = texts[0] ?? '';
    for (const next of texts.slice(1))
        text = `${row.target}(${text}, ${next})`;
    return atom(text);
}
function fallback(ctx, call, row, path) {
    const bound = bind(call, row.params);
    if (!onlyKnown(ctx, path, bound, row.params))
        return NOTHING;
    const source = argText(ctx, bound, 'source');
    if (source === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'source', call: path }));
        return NOTHING;
    }
    return atom(`orElse(${source}, ${argText(ctx, bound, 'replacement') ?? '0'})`);
}
function rgb(ctx, call, row, path) {
    const bound = bind(call, row.params);
    if (!onlyKnown(ctx, path, bound, row.params))
        return NOTHING;
    const channels = ['red', 'green', 'blue'].map((name) => argText(ctx, bound, name));
    if (channels.some((one) => one === undefined)) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'a colour channel', call: path }));
        return NOTHING;
    }
    const colour = `rgb(${channels.join(', ')})`;
    const transp = argText(ctx, bound, 'transp');
    return atom(transp === undefined ? colour : `fade(${colour}, ${transp})`);
}
export function translateCall(ctx, call) {
    const path = pathOf(call.callee);
    const root = path?.split('.')[0];
    const binding = root === undefined ? undefined : ctx.lookup(root, call.callee.at);
    if (path === undefined || (binding !== undefined && (path !== root || binding.kind !== 'function'))) {
        ctx.refuse(diagnosticFor('OS9002', ctx.span(call.callee.at), { construct: 'a call on a value' }));
        return NOTHING;
    }
    if (binding !== undefined)
        return userCall(ctx, call, binding);
    const row = CALLS.get(path);
    if (row === undefined) {
        ctx.refuse(diagnosticFor('OS9003', ctx.span(call.callee.at), { name: path }));
        return NOTHING;
    }
    switch (row.special) {
        case undefined:
            return generic(ctx, call, row, path);
        case 'trueRange':
            return trueRangeCall(ctx, call, path);
        case 'extreme':
            return extreme(ctx, call, row, path);
        case 'deviation':
            return deviation(ctx, call, row, path);
        case 'condition':
            return condition(ctx, call, row, path);
        case 'extremes':
            return extremes(ctx, call, row, path);
        case 'fallback':
            return fallback(ctx, call, row, path);
        case 'rgb':
            return rgb(ctx, call, row, path);
        case 'float': {
            const bound = bind(call, row.params);
            if (!onlyKnown(ctx, path, bound, row.params))
                return NOTHING;
            const arg = bound.byName.get('x');
            return arg === undefined ? atom('none') : atom(`(${translate(ctx, arg.value).text})`);
        }
        case 'input':
            return translateInput(ctx, call, path, false);
        case 'plot':
            return plotCall(ctx, call, path);
        case 'hline':
            return levelCall(ctx, call, path);
    }
    ctx.refuse(diagnosticFor('OS9002', ctx.span(call.callee.at), { construct: `${path} used as a value` }));
    return NOTHING;
}
//# sourceMappingURL=calls.js.map