/**
 * Expressions, written out as OpenScript text.
 *
 * Each translation carries the precedence of its outermost operator, and a
 * parent wraps a child in brackets only where OpenScript's grammar would
 * otherwise group it differently, so the output groups exactly as the source
 * did (`language.md` 9.1). Brackets the source wrote are kept as written.
 *
 * Three operators are where the two languages part, and each is translated to
 * the source dialect's meaning rather than to the nearest spelling:
 *
 *   - `not`, which the source dialect applies to a comparison it has already
 *     answered `false` on an absent side, is written over `orElse(x, false)`.
 *   - `and` and `or`, whose right operand version 5 always evaluates and
 *     version 6 evaluates only when its left operand did not decide, where
 *     OpenScript also evaluates it when the left is absent (`language.md` 9.4).
 *     That matters only where the right operand holds state, and there version
 *     5's operand is moved to a line of its own and version 6's left operand is
 *     written over `orElse`.
 *   - `==` against `na`, which the source dialect answers `false` on every bar,
 *     is refused rather than translated to a test for absence.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { translateCall, trueRangeValue } from './calls.js';
import { quoted } from './context.js';
import { holdsState, neverAbsent, wholeConstant } from './presence.js';
import { pathOf } from './syntax.js';
import { COLOURS, VALUES } from './table.js';
export const PREC = {
    ternary: 1,
    or: 2,
    and: 3,
    equality: 4,
    comparison: 5,
    additive: 6,
    multiplicative: 7,
    unary: 8,
    atom: 9,
};
export const atom = (text) => ({ text, prec: PREC.atom });
/** Stands in for a translation that was refused; the statement is not written. */
export const NOTHING = atom('none');
export function wrap(out, min) {
    return out.prec >= min ? out.text : `(${out.text})`;
}
/** The words OS9002 names a strict operand the importer cannot move with. */
export const STRICT = 'a version 5 and or or whose second operand holds state, in a condition that runs only on some passes';
/** A number as OpenScript writes one: no trailing point, a lower case exponent. */
export function numberText(text) {
    const lower = text.toLowerCase();
    const [mantissa = '', exponent] = lower.split('e');
    const tidy = mantissa.endsWith('.') ? `${mantissa}0` : mantissa;
    return exponent === undefined ? tidy : `${tidy}e${exponent}`;
}
export function translate(ctx, expr) {
    switch (expr.kind) {
        case 'number':
            return atom(numberText(expr.text));
        case 'string':
            return atom(quoted(expr.value));
        case 'bool':
            return atom(expr.value ? 'true' : 'false');
        case 'color':
            return atom(expr.text.toLowerCase());
        case 'name':
            return nameOf(ctx, expr);
        case 'member':
            return memberOf(ctx, expr);
        case 'call':
            return translateCall(ctx, expr);
        case 'index': {
            const target = translate(ctx, expr.target);
            const index = translate(ctx, expr.index);
            return atom(`${wrap(target, PREC.atom)}[${index.text}]`);
        }
        case 'unary':
            return unaryOf(ctx, expr);
        case 'binary':
            return binaryOf(ctx, expr);
        case 'ternary':
            return ternaryOf(ctx, expr);
        case 'group':
            return atom(`(${translate(ctx, expr.inner).text})`);
        case 'list':
            ctx.refuse(diagnosticFor('OS9002', ctx.span(expr.at), { construct: 'an array or tuple literal' }));
            return NOTHING;
    }
}
function nameOf(ctx, expr) {
    const binding = ctx.lookup(expr.name, expr.at);
    if (binding !== undefined) {
        if (binding.kind === 'function') {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(expr.at), { construct: 'a function used as a value' }));
            return NOTHING;
        }
        return atom(binding.output);
    }
    const row = VALUES.get(expr.name);
    if (row !== undefined)
        return atom(row.target);
    ctx.refuse(diagnosticFor('OS9003', ctx.span(expr.at), { name: expr.name }));
    return NOTHING;
}
function memberOf(ctx, expr) {
    const path = pathOf(expr);
    const root = path?.split('.')[0];
    if (path === undefined || root === undefined || ctx.lookup(root, expr.at) !== undefined) {
        ctx.refuse(diagnosticFor('OS9002', ctx.span(expr.at), { construct: 'a field read from a value' }));
        return NOTHING;
    }
    if (path === 'ta.tr')
        return trueRangeValue();
    const row = VALUES.get(path);
    if (row !== undefined)
        return atom(row.target);
    if (root === 'color' && COLOURS.has(expr.property))
        return atom(expr.property);
    ctx.refuse(diagnosticFor('OS9003', ctx.span(expr.at), { name: path }));
    return NOTHING;
}
/** The expression inside any brackets the source wrapped it in. */
function unwrapped(expr) {
    return expr.kind === 'group' ? unwrapped(expr.inner) : expr;
}
function unaryOf(ctx, expr) {
    if (expr.op === 'not' && !neverAbsent(ctx, expr.operand)) {
        return { text: `not orElse(${translate(ctx, unwrapped(expr.operand)).text}, false)`, prec: PREC.unary };
    }
    const operand = translate(ctx, expr.operand);
    if (expr.op === 'not')
        return { text: `not ${wrap(operand, PREC.unary)}`, prec: PREC.unary };
    const inner = wrap(operand, PREC.unary);
    const text = inner.startsWith('-') || inner.startsWith('+') ? `${expr.op}(${inner})` : `${expr.op}${inner}`;
    return { text, prec: PREC.unary };
}
/** A translation written as an argument, without the one pair of brackets the source put round it. */
function bare(out) {
    const text = out.text;
    if (!text.startsWith('(') || !text.endsWith(')'))
        return text;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '(')
            depth += 1;
        else if (text[i] === ')')
            depth -= 1;
        if (depth === 0 && i < text.length - 1)
            return text;
    }
    return text.slice(1, -1);
}
function isNa(ctx, expr) {
    return expr.kind === 'name' && expr.name === 'na' && ctx.scope.find('na') === undefined;
}
function equalityOf(ctx, expr) {
    if (isNa(ctx, expr.left) || isNa(ctx, expr.right)) {
        ctx.refuse(diagnosticFor('OS9002', ctx.span(expr.at), { construct: 'a comparison with na' }));
        return NOTHING;
    }
    const left = translate(ctx, expr.left);
    const right = translate(ctx, expr.right);
    let leftText = wrap(left, PREC.equality + 1);
    let rightText = wrap(right, PREC.equality + 1);
    const leftPresent = neverAbsent(ctx, expr.left);
    const rightPresent = neverAbsent(ctx, expr.right);
    if (expr.right.kind === 'bool' && !leftPresent)
        leftText = `orElse(${bare(left)}, false)`;
    else if (expr.left.kind === 'bool' && !rightPresent)
        rightText = `orElse(${bare(right)}, false)`;
    else if (!leftPresent && !rightPresent) {
        ctx.note(diagnosticFor('OS9011', ctx.span(expr.opAt), { operator: expr.op }));
    }
    return { text: `${leftText} ${expr.op} ${rightText}`, prec: PREC.equality };
}
function logicOf(ctx, expr) {
    const prec = expr.op === 'and' ? PREC.and : PREC.or;
    const left = translate(ctx, expr.left);
    let leftText = wrap(left, prec);
    let right;
    if (!holdsState(ctx, expr.right)) {
        right = translate(ctx, expr.right);
    }
    else if (ctx.facts.version === 5) {
        const operand = translate(ctx, expr.right);
        if (ctx.refused)
            return NOTHING;
        const name = ctx.hoist(operand.text);
        if (name === undefined) {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(expr.opAt), { construct: STRICT }));
            return NOTHING;
        }
        right = atom(name);
    }
    else {
        right = translate(ctx, expr.right);
        if (expr.op === 'and' && !neverAbsent(ctx, expr.left))
            leftText = `orElse(${left.text}, false)`;
    }
    return { text: `${leftText} ${expr.op} ${wrap(right, prec + 1)}`, prec };
}
function binaryOf(ctx, expr) {
    switch (expr.op) {
        case 'and':
        case 'or':
            return logicOf(ctx, expr);
        case '==':
        case '!=':
            return equalityOf(ctx, expr);
    }
    const left = translate(ctx, expr.left);
    const right = translate(ctx, expr.right);
    let prec = PREC.comparison;
    if (expr.op === '+' || expr.op === '-')
        prec = PREC.additive;
    else if (expr.op === '*' || expr.op === '/' || expr.op === '%')
        prec = PREC.multiplicative;
    if (expr.op === '/' && ctx.facts.version === 5 && wholeConstant(ctx, expr.left) && wholeConstant(ctx, expr.right)) {
        ctx.note(diagnosticFor('OS9008', ctx.span(expr.opAt), {}));
    }
    // Comparisons do not chain in OpenScript, so both sides are wrapped past them.
    const leftMin = prec === PREC.comparison ? prec + 1 : prec;
    return { text: `${wrap(left, leftMin)} ${expr.op} ${wrap(right, prec + 1)}`, prec };
}
function ternaryOf(ctx, expr) {
    const condition = translate(ctx, expr.condition);
    ctx.lazy += 1;
    try {
        const then = translate(ctx, expr.then);
        const otherwise = translate(ctx, expr.otherwise);
        return { text: `${wrap(condition, PREC.or)} ? ${then.text} : ${wrap(otherwise, PREC.ternary)}`, prec: PREC.ternary };
    }
    finally {
        ctx.lazy -= 1;
    }
}
//# sourceMappingURL=values.js.map