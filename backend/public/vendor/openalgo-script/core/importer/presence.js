import { pathOf } from './syntax.js';
import { CALLS, COLOURS } from './table.js';
/** Built-in series that hold a value on every bar, from bar 0. Volume can be absent. */
const PRESENT_SERIES = new Set(['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'time', 'bar_index']);
/** Calls that return a present value whenever their arguments are present. */
const PRESENT_WHEN_ARGUMENTS_ARE = new Set([
    'math.abs', 'math.max', 'math.min', 'math.floor', 'math.ceil', 'math.sign', 'int', 'float',
]);
function namePresent(ctx, name) {
    const binding = ctx.scope.find(name);
    if (binding !== undefined)
        return binding.present;
    return PRESENT_SERIES.has(name);
}
function callPresent(ctx, expr) {
    const path = pathOf(expr.callee);
    if (path === undefined || ctx.scope.find(path.split('.')[0] ?? '') !== undefined)
        return false;
    if (path === 'na')
        return true;
    if (path === 'nz')
        return expr.args.length < 2 || neverAbsent(ctx, expr.args[1]?.value);
    if (path.startsWith('input'))
        return true;
    if (path === 'color.new' || path === 'color.rgb')
        return true;
    if (PRESENT_WHEN_ARGUMENTS_ARE.has(path))
        return expr.args.every((arg) => neverAbsent(ctx, arg.value));
    return false;
}
/** Whether an expression holds a value on every bar, as far as the tree can show. */
export function neverAbsent(ctx, expr) {
    if (expr === undefined)
        return false;
    switch (expr.kind) {
        case 'number':
        case 'string':
        case 'bool':
        case 'color':
            return true;
        case 'name':
            return namePresent(ctx, expr.name);
        case 'member': {
            const path = pathOf(expr) ?? '';
            if (path.startsWith('barstate.') || path === 'math.pi' || path === 'math.e')
                return true;
            if (path === 'strategy.position_size')
                return true;
            return path.startsWith('color.') && COLOURS.has(expr.property);
        }
        case 'unary':
            return neverAbsent(ctx, expr.operand);
        case 'binary':
            if (expr.op === '/' || expr.op === '%')
                return false;
            return neverAbsent(ctx, expr.left) && neverAbsent(ctx, expr.right);
        case 'ternary':
            return neverAbsent(ctx, expr.then) && neverAbsent(ctx, expr.otherwise);
        case 'group':
            return neverAbsent(ctx, expr.inner);
        case 'call':
            return callPresent(ctx, expr);
        case 'index':
        case 'list':
            return false;
    }
}
/** Whether evaluating an expression runs a call that keeps state at its call site. */
export function holdsState(ctx, expr) {
    switch (expr.kind) {
        case 'call': {
            const path = pathOf(expr.callee);
            if (path !== undefined) {
                const binding = ctx.scope.find(path);
                if (binding !== undefined && binding.kind === 'function')
                    return true;
                if (CALLS.get(path)?.stateful === true)
                    return true;
            }
            return holdsState(ctx, expr.callee) || expr.args.some((arg) => holdsState(ctx, arg.value));
        }
        case 'member':
            return holdsState(ctx, expr.object);
        case 'index':
            return holdsState(ctx, expr.target) || holdsState(ctx, expr.index);
        case 'unary':
            return holdsState(ctx, expr.operand);
        case 'binary':
            return holdsState(ctx, expr.left) || holdsState(ctx, expr.right);
        case 'ternary':
            return holdsState(ctx, expr.condition) || holdsState(ctx, expr.then) || holdsState(ctx, expr.otherwise);
        case 'group':
            return holdsState(ctx, expr.inner);
        case 'list':
            return expr.items.some((item) => holdsState(ctx, item));
        default:
            return false;
    }
}
/** A whole-number literal, as the source writes one: no point and no exponent. */
function wholeLiteral(text) {
    return /^[0-9]+$/.test(text);
}
/** Whether an expression is a whole-number constant in version 5's sense. */
export function wholeConstant(ctx, expr) {
    switch (expr.kind) {
        case 'number':
            return wholeLiteral(expr.text);
        case 'name':
            return ctx.scope.find(expr.name)?.whole === true;
        case 'unary':
            return expr.op !== 'not' && wholeConstant(ctx, expr.operand);
        case 'group':
            return wholeConstant(ctx, expr.inner);
        case 'binary':
            return ['+', '-', '*', '/', '%'].includes(expr.op) && wholeConstant(ctx, expr.left) && wholeConstant(ctx, expr.right);
        default:
            return false;
    }
}
/** Whether a name is read anywhere inside an expression. */
export function mentions(expr, name) {
    switch (expr.kind) {
        case 'name':
            return expr.name === name;
        case 'member':
            return mentions(expr.object, name);
        case 'call':
            return mentions(expr.callee, name) || expr.args.some((arg) => mentions(arg.value, name));
        case 'index':
            return mentions(expr.target, name) || mentions(expr.index, name);
        case 'unary':
            return mentions(expr.operand, name);
        case 'binary':
            return mentions(expr.left, name) || mentions(expr.right, name);
        case 'ternary':
            return mentions(expr.condition, name) || mentions(expr.then, name) || mentions(expr.otherwise, name);
        case 'group':
            return mentions(expr.inner, name);
        case 'list':
            return expr.items.some((item) => mentions(item, name));
        default:
            return false;
    }
}
//# sourceMappingURL=presence.js.map