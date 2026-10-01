import { withoutGrouping } from '../ast/index.js';
import { bindArguments } from './arguments.js';
import { remember, resolveLibraryCall, unresolved } from './calls.js';
import { calleeNameOf, isCompileTimeConstant, isSourceName, readsInputInPart } from './constant.js';
import { checkExpression } from './expressions.js';
import { ensureChecked } from './functions.js';
import { allowHandle, refuseHandle } from './handles.js';
import { isLibraryName, isOrderName, isRequestName } from './surface.js';
import { closestName } from './suggest.js';
import { NUMBER, STRING, UNKNOWN, accepts, elementOf, seriesOf, typeText } from './types.js';
import { BAR_ZERO, allOf, later, weaken } from './warmup.js';
/** A timeframe is a count and a unit, and the unit letters are case sensitive. */
const TIMEFRAME = /^[0-9]+(m|h|D|W|M)?$/;
/** The input kinds `stdlib.md` 13.1 names and does not ship in version 1. */
const PLANNED_KINDS = new Set(['symbol', 'price', 'session']);
const SHIPPED_KINDS = ['interval', 'time'];
/** The calls `stdlib.md` 15.4 refuses inside a request expression, with OS3006. */
const DRAWING_CALLS = new Set([
    'plot',
    'plotCandles',
    'fill',
    'level',
    'table',
    'cell',
    'clear',
    'signal',
    'background',
    'barColor',
    'alert',
]);
export function resolveCall(checker, call, placement) {
    const name = calleeNameOf(call.callee);
    if (name === undefined) {
        checker.report('OS2010', call.span, {
            name: checker.textOf(call.callee.span),
            type: typeText(UNKNOWN),
            suggestion: checker.callSuggestionFor(checker.textOf(call.callee.span), call.args.map((one) => checker.textOf(one.span))),
        });
        return record(checker, call, unresolved(call, 'call'));
    }
    const functionIndex = checker.functionsByName.get(name);
    if (functionIndex !== undefined) {
        checkArgumentExpressions(checker, call, placement);
        return record(checker, call, checkUserCall(checker, call, name, functionIndex));
    }
    if (!isLibraryName(name)) {
        checkArgumentExpressions(checker, call, placement);
        checker.report('OS2001', call.callee.span, {
            name,
            suggestion: checker.suggestionFor(name),
        });
        return record(checker, call, unresolved(call, name));
    }
    if (checker.requestDepth > 0)
        refuseInsideRequest(checker, call, name);
    if (isRequestName(name))
        return record(checker, call, checkRequest(checker, call, name, placement));
    checkArgumentExpressions(checker, call, placement);
    const checked = resolveLibraryCall(checker, call, name, placement);
    if (name !== 'input')
        return record(checker, call, checked);
    return record(checker, call, checkInput(checker, call, checked));
}
function record(checker, call, checked) {
    checker.record(call, checked.returns, checked.warmup);
    return checked.returns;
}
/**
 * Every argument, checked as an expression.
 *
 * An argument is one of the three places a declaration handle may be written
 * (`language.md` 5.4), because `fill(upper, lower)` is how a band is declared.
 * Whether this particular parameter takes one is the signature's answer and not
 * this pass's: `validateArguments` gives it, with OS3020, OS3019 or OS3011.
 */
function checkArgumentExpressions(checker, call, placement) {
    for (const argument of call.args) {
        allowHandle(checker, argument.value);
        checkExpression(checker, argument.value, placement);
    }
}
/** OS7003 and OS3006: what a request expression may not contain. */
function refuseInsideRequest(checker, call, name) {
    if (isOrderName(name))
        checker.report('OS7003', call.span, { name });
    else if (DRAWING_CALLS.has(name) || name.startsWith('draw.')) {
        checker.report('OS3006', call.span, { name, construct: 'a request expression' });
    }
}
/**
 * A higher timeframe or other instrument read, `stdlib.md` 15.
 *
 * The expression argument is compiled against the requested bars, so it is
 * checked with the request depth raised: a file-scope name read inside it is
 * OS6003, because a value computed on this chart's bars has no counterpart on
 * the requested ones.
 */
function checkRequest(checker, call, name, placement) {
    const expression = expressionArgument(call, name);
    for (const argument of call.args) {
        allowHandle(checker, argument.value);
        if (argument === expression) {
            checker.requestDepth += 1;
            try {
                checkExpression(checker, argument.value, placement);
            }
            finally {
                checker.requestDepth -= 1;
            }
        }
        else {
            checkExpression(checker, argument.value, placement);
        }
    }
    const checked = resolveLibraryCall(checker, call, name, placement);
    const timeframe = timeframeArgument(call, name);
    const written = timeframe === undefined ? undefined : stringLiteral(timeframe.value);
    if (written !== undefined && !TIMEFRAME.test(written)) {
        checker.report('OS6001', timeframe?.span ?? call.span, { value: written });
    }
    const mode = modeOf(checked);
    if (mode === 'lookahead') {
        checker.report('OS8005', call.span, { mode });
        checker.repaints = true;
    }
    if (checker.declaration?.onUnconfirmed === true) {
        checker.report('OS8002', call.span, {
            timeframe: written ?? (timeframe === undefined ? '' : checker.textOf(timeframe.value.span)),
        });
    }
    checker.requests.push({
        id: checker.requests.length,
        call,
        name,
        mode,
        timeframe: written ?? (timeframe === undefined ? '' : checker.textOf(timeframe.value.span)),
        repaints: mode === 'lookahead',
        span: call.span,
    });
    return checked;
}
function expressionArgument(call, name) {
    const labelled = call.args.find((one) => one.label?.text === 'expr');
    if (labelled !== undefined)
        return labelled;
    const positional = call.args.filter((one) => one.label === undefined);
    return positional[name === 'req.symbol' ? 2 : 1];
}
function timeframeArgument(call, name) {
    const labelled = call.args.find((one) => one.label?.text === 'timeframe');
    if (labelled !== undefined)
        return labelled;
    const positional = call.args.filter((one) => one.label === undefined);
    return positional[name === 'req.symbol' ? 1 : 0];
}
/**
 * The mode as the signature bound it, written by its label or in its place.
 *
 * `language.md` 11.2 fills parameters from the left, so `mode` is the third
 * argument of `req.timeframe` and the fifth of `req.symbol` whether or not it
 * carries its label, and the emitter reads every other argument of a read from
 * the same binding. Looking for the label alone read a positional
 * `"lookahead"` as the default: the study ran confirmed, with no OS8005 and no
 * repaint mark, while its source named the mode on the line.
 */
function modeOf(checked) {
    const bound = argumentOf(checked, 'mode');
    const written = bound === undefined ? undefined : stringLiteral(bound.value);
    if (written === 'confirmed' || written === 'developing' || written === 'lookahead') {
        return written;
    }
    // The default is the one mode that never repaints (stdlib.md 15.3).
    return bound === undefined ? 'confirmed' : 'unknown';
}
function stringLiteral(expression) {
    const inner = withoutGrouping(expression);
    return inner.kind === 'stringLiteral' ? inner.value : undefined;
}
/**
 * `input()`, whose type follows its default, `stdlib.md` 13.1.
 *
 * The default is the one place a bare price series stands where a constant is
 * otherwise required: `input(close, "Source")` names a column rather than
 * reading one, and the host resolves it before bar 0 like every other input.
 */
function checkInput(checker, call, checked) {
    const value = checked.arguments[0];
    const kind = literalOf(checked, 'kind');
    const options = argumentOf(checked, 'options');
    const title = literalOf(checked, 'title');
    if (value !== undefined && !isSourceName(value.value)) {
        if (!isCompileTimeConstant(checker, value.value)) {
            checker.report('OS3003', value.span, { option: 'value' });
        }
        else if (readsInputInPart(checker, value.value, false)) {
            checker.report('OS3025', value.span, { option: 'value' });
        }
    }
    if (kind !== undefined && PLANNED_KINDS.has(kind)) {
        checker.report('OS2001', call.span, {
            name: `input(kind = "${kind}")`,
            suggestion: closestName(kind, SHIPPED_KINDS),
        });
    }
    reportDefaultOutsideOptions(checker, value, options);
    const given = value === undefined ? UNKNOWN : checker.typeOf(value.value);
    const source = value !== undefined && isSourceName(value.value);
    const inputKind = kindOf(given, source, kind, options !== undefined);
    const returns = returnTypeOf(inputKind, given);
    checker.inputs.push({
        id: checker.inputs.length,
        call,
        name: '',
        title: title ?? '',
        titleWritten: title !== undefined,
        kind: inputKind,
        type: returns,
        span: call.span,
    });
    return { ...checked, returns, warmup: BAR_ZERO };
}
/**
 * OS3018: a menu whose default is not one of the choices it offers.
 *
 * The dialog has to show something on the first open, and a value outside the
 * list means either the list is short by one or the default is a typo. Both are
 * the script's to settle, and guessing either way changes what the study does.
 */
function reportDefaultOutsideOptions(checker, value, options) {
    if (value === undefined || options === undefined)
        return;
    const written = stringLiteral(value.value);
    const list = withoutGrouping(options.value);
    if (written === undefined || list.kind !== 'arrayLiteral')
        return;
    const members = list.elements.map((element) => stringLiteral(element));
    if (members.some((one) => one === undefined) || members.includes(written))
        return;
    checker.report('OS3018', value.span, {
        default: JSON.stringify(written),
        values: `[${members.map((one) => JSON.stringify(one)).join(', ')}]`,
    });
}
function kindOf(given, source, kind, hasOptions) {
    if (source)
        return 'source';
    if (kind === 'interval')
        return 'interval';
    if (kind === 'time')
        return 'time';
    const element = elementOf(given);
    if (element.kind === 'bool')
        return 'bool';
    if (element.kind === 'color')
        return 'color';
    if (element.kind === 'number')
        return 'number';
    return hasOptions ? 'select' : 'string';
}
function returnTypeOf(kind, given) {
    if (kind === 'source')
        return seriesOf(NUMBER);
    if (kind === 'time')
        return NUMBER;
    if (kind === 'interval' || kind === 'select' || kind === 'string')
        return STRING;
    return elementOf(given);
}
function argumentOf(checked, name) {
    const index = checked.entry?.parameters.findIndex((one) => one.name === name) ?? -1;
    return index < 0 ? undefined : checked.arguments[index];
}
function literalOf(checked, name) {
    const argument = argumentOf(checked, name);
    return argument === undefined ? undefined : stringLiteral(argument.value);
}
/**
 * A call to a function the file declares, `language.md` 11.2.
 *
 * State is allocated per call site and not per function (11.4), so two calls to
 * one stateful helper are two independent counters, and each of them takes a
 * state region of its own here.
 */
function checkUserCall(checker, call, name, index) {
    ensureChecked(checker, index);
    const fn = checker.functions[index];
    if (fn === undefined)
        return unresolvedAndRemembered(checker, call, name);
    const shapes = fn.declaration.parameters.map((one) => ({
        name: one.name.text,
        optional: one.defaultValue !== undefined,
    }));
    const filled = bindArguments(checker, call.span, call.args, name, shapes);
    const series = [];
    for (let i = 0; i < fn.parameters.length; i += 1) {
        const parameter = fn.parameters[i];
        const argument = filled[i];
        if (parameter === undefined || argument === undefined)
            continue;
        const given = checker.typeOf(argument.value);
        if (!accepts(parameter.type, given)) {
            checker.report('OS3011', argument.span, {
                name,
                argument: parameter.name,
                expected: typeText(parameter.type),
                found: typeText(given),
            });
        }
        else if (given.kind === 'handle') {
            // A parameter with nothing written about it takes whatever the caller
            // passes, and `accepts` therefore lets a handle through. No user function
            // takes one: a body runs per bar and a handle has no value on a bar
            // (`language.md` 5.4).
            refuseHandle(checker, argument.value, given);
        }
        if (parameter.readsHistory)
            series.push(i);
    }
    if (fn.stateful && checker.isConditional(call))
        checker.report('OS8001', call.span, { name });
    const supplied = filled.filter((one) => one !== undefined);
    const warmup = later(fn.warmup, allOf(supplied.map((one) => checker.warmupOf(one.value))));
    const checked = {
        call,
        name,
        target: 'user',
        entry: undefined,
        fn: index,
        arguments: filled,
        returns: fn.returns,
        warmup: fn.stateful ? weaken(warmup) : warmup,
        stateful: fn.stateful,
        stateId: fn.stateful ? checker.takeStateId() : undefined,
        seriesArguments: series,
    };
    remember(checker, checked);
    return checked;
}
function unresolvedAndRemembered(checker, call, name) {
    const checked = unresolved(call, name);
    remember(checker, checked);
    return checked;
}
//# sourceMappingURL=call-sites.js.map