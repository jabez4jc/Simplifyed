import { withoutGrouping } from '../ast/index.js';
import { bindArguments } from './arguments.js';
import { validateArguments } from './calls.js';
import { literalNumber } from './literals.js';
import { TOP_LEVEL } from './checker.js';
import { checkExpression } from './expressions.js';
import { entry, wholeRange } from './library.js';
import { CATALOGUE_LANGUAGE_VERSION } from '../catalogue/index.js';
const STUDY_OPTIONS = 'title: string, short?: string, overlay?: bool, precision?: number, format?: string, ' +
    'range?: array<number>, scale?: string, group?: string, onUnconfirmed?: bool';
const STRATEGY_OPTIONS = 'capital?: number, currency?: string, qty?: number, qtyType?: string, product?: string, ' +
    'fillOn?: string, slippage?: number, commission?: number, commissionType?: string, ' +
    'pyramiding?: number, closeOnSessionEnd?: bool';
const SHARED = {
    values: {
        format: ['price', 'percent', 'volume'],
        scale: ['right', 'left', 'none'],
        qtyType: ['units', 'lots', 'cash', 'equityPercent'],
        product: ['intraday', 'overnight'],
        fillOn: ['nextOpen', 'close'],
        commissionType: ['perTrade', 'perUnit', 'percent'],
    },
    whole: { precision: wholeRange(0, 10), pyramiding: wholeRange(1) },
};
/** Every option value is read once, before the first bar, so all are constant. */
function constantNames(signature) {
    return signature
        .split(',')
        .map((part) => part.split(':')[0]?.trim().replace('?', '') ?? '')
        .filter((name) => name.length > 0);
}
const STUDY = entry(`study(${STUDY_OPTIONS}) -> nothing`, {
    ...SHARED,
    constant: constantNames(STUDY_OPTIONS),
});
const STRATEGY = entry(`strategy(${STUDY_OPTIONS}, ${STRATEGY_OPTIONS}) -> nothing`, {
    ...SHARED,
    constant: [...constantNames(STUDY_OPTIONS), ...constantNames(STRATEGY_OPTIONS)],
});
/** The options of `limits()`, `language.md` 10.7. */
const LIMITS = entry('limits(loops?: number, history?: number) -> nothing');
/**
 * Finds the file's declaration and reads the two options every later rule needs.
 *
 * This runs before anything else is checked, because OS7001 has to know whether
 * the file is a strategy and OS8002 has to know whether it runs on a bar that
 * is still moving, and both questions are asked of lines above the declaration
 * as readily as of lines below it.
 */
export function readHeader(checker, script) {
    const declarations = script.items.filter((item) => item.kind === 'scriptDeclaration');
    const first = declarations[0];
    if (first === undefined) {
        checker.report('OS2007', script.span, {});
    }
    else {
        checker.declaration = {
            node: first,
            form: first.form,
            title: stringOption(first, 'title', 0) ?? '',
            options: optionsOf(first),
            overlay: booleanOption(first, 'overlay') === true,
            onUnconfirmed: booleanOption(first, 'onUnconfirmed') === true,
        };
    }
    for (const extra of declarations.slice(1)) {
        checker.report('OS2008', extra.span, {
            kind: first?.form ?? extra.form,
            line: first?.span.line ?? extra.span.line,
        });
    }
    if (!script.items.some((item) => item.kind === 'versionLine')) {
        checker.report('OS8003', script.span, { version: CATALOGUE_LANGUAGE_VERSION });
    }
}
/** The declaration's own arguments, checked where the declaration is written. */
export function checkDeclaration(checker, node) {
    for (const argument of node.args)
        checkExpression(checker, argument.value, TOP_LEVEL);
    const shape = node.form === 'strategy' ? STRATEGY : STUDY;
    const parameters = shape.parameters.map((one) => ({
        name: one.name,
        optional: one.optional,
    }));
    const filled = bindArguments(checker, node.span, node.args, node.form, parameters);
    validateArguments(checker, shape, filled, new Map());
    checkRangeOption(checker, shape, filled);
}
/**
 * `range = [min, max]`, which is two numbers with the first below the second.
 *
 * OS3016 rather than OS3011, because the shape is right and the contents are
 * not, and a reader given "array<number> was expected" would look at the wrong
 * thing.
 */
function checkRangeOption(checker, shape, filled) {
    const index = shape.parameters.findIndex((one) => one.name === 'range');
    const argument = index < 0 ? undefined : filled[index];
    if (argument === undefined)
        return;
    const literal = withoutGrouping(argument.value);
    if (literal.kind !== 'arrayLiteral')
        return;
    const low = literal.elements[0] === undefined ? undefined : literalNumber(literal.elements[0]);
    const high = literal.elements[1] === undefined ? undefined : literalNumber(literal.elements[1]);
    const wrong = literal.elements.length !== 2 ||
        low === undefined ||
        high === undefined ||
        low >= high;
    if (!wrong)
        return;
    checker.report('OS3016', literal.span, {
        low: literal.elements[0] === undefined ? '' : checker.textOf(literal.elements[0].span),
        high: literal.elements[1] === undefined ? '' : checker.textOf(literal.elements[1].span),
    });
}
/**
 * `limits()`, which appears at most once and immediately after the declaration.
 *
 * Its values are literal numbers rather than compile-time constants, because
 * the host is asked whether it will run them before the program is loaded and
 * an `input()` is not resolved that early.
 */
export function checkLimits(checker, node, script, seen) {
    for (const argument of node.args)
        checkExpression(checker, argument.value, TOP_LEVEL);
    const parameters = LIMITS.parameters.map((one) => ({
        name: one.name,
        optional: one.optional,
    }));
    const filled = bindArguments(checker, node.span, node.args, 'limits', parameters);
    validateArguments(checker, LIMITS, filled, new Map());
    if (seen || !immediatelyAfterDeclaration(script, node)) {
        checker.report('OS3014', node.span, { line: node.span.line });
    }
    for (let i = 0; i < LIMITS.parameters.length; i += 1) {
        const parameter = LIMITS.parameters[i];
        const argument = filled[i];
        if (parameter === undefined || argument === undefined)
            continue;
        if (literalNumber(argument.value) === undefined) {
            checker.report('OS3015', argument.span, { option: parameter.name });
        }
    }
}
function immediatelyAfterDeclaration(script, node) {
    const index = script.items.indexOf(node);
    const before = index <= 0 ? undefined : script.items[index - 1];
    return before?.kind === 'scriptDeclaration';
}
function optionsOf(node) {
    const options = new Map();
    let positional = 0;
    for (const argument of node.args) {
        if (argument.label === undefined) {
            if (positional === 0)
                options.set('title', argument.value);
            positional += 1;
            continue;
        }
        options.set(argument.label.text, argument.value);
    }
    return options;
}
function stringOption(node, name, position) {
    const labelled = node.args.find((one) => one.label?.text === name);
    const positional = node.args.filter((one) => one.label === undefined)[position];
    const chosen = labelled ?? positional;
    if (chosen === undefined)
        return undefined;
    const inner = withoutGrouping(chosen.value);
    return inner.kind === 'stringLiteral' ? inner.value : undefined;
}
function booleanOption(node, name) {
    const labelled = node.args.find((one) => one.label?.text === name);
    if (labelled === undefined)
        return undefined;
    const inner = withoutGrouping(labelled.value);
    return inner.kind === 'booleanLiteral' ? inner.value : undefined;
}
//# sourceMappingURL=declaration.js.map