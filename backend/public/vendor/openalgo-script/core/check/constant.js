import { withoutGrouping } from '../ast/index.js';
import { inputHeldBy } from './checked.js';
import { BAR_SERIES } from './surface.js';
/** The names `math` holds that are numbers rather than functions. */
const CONSTANT_MEMBERS = new Set(['math.pi', 'math.e']);
/**
 * The calls that produce a value before the first bar, `stdlib.md` 11.2.
 *
 * A colour built out of constants is a constant: `fade(red, 50)` is the same
 * four numbers on every bar, and a level or a marker declared with one has a
 * colour to carry. The list is here, beside the rule, because the compiler folds
 * exactly these and the two have to be one list rather than two. A call this
 * accepted and the emitter could not fold would reach a declaration field with
 * nothing to write in it, and the compiler would have to refuse a script that
 * the checker had already passed.
 */
export const FOLDABLE_CALLS = new Set([
    'rgb',
    'rgba',
    'fade',
    'withAlpha',
    'alpha',
    'mix',
]);
export function isCompileTimeConstant(checker, expression) {
    const inner = withoutGrouping(expression);
    switch (inner.kind) {
        case 'numberLiteral':
        case 'stringLiteral':
        case 'booleanLiteral':
        case 'colorLiteral':
        case 'noneLiteral':
            return true;
        case 'arrayLiteral':
            return inner.elements.every((element) => isCompileTimeConstant(checker, element));
        case 'unary':
            return isCompileTimeConstant(checker, inner.operand);
        case 'binary':
            return (isCompileTimeConstant(checker, inner.left) && isCompileTimeConstant(checker, inner.right));
        case 'ternary':
            return (isCompileTimeConstant(checker, inner.condition) &&
                isCompileTimeConstant(checker, inner.whenTrue) &&
                isCompileTimeConstant(checker, inner.whenFalse));
        case 'nameReference': {
            const binding = checker.lookup(inner.name);
            // A name that holds a setting is one, and a `var` initialised from one is
            // not: the cell is the setting's value on the first bar and whatever the
            // bar puts in it after that, so it is fixed before bar 0 only until
            // something assigns to it (`language.md` 8.2 and 13.4).
            if (binding !== undefined)
                return inputHeldBy(binding) !== undefined;
            // A colour name is an ordinary global of type `color` and never changes.
            return checker.typeOf(inner).kind === 'color';
        }
        case 'member':
            return CONSTANT_MEMBERS.has(memberPath(inner.object, inner.member.text));
        case 'call': {
            const name = calleeName(inner.callee);
            if (name === 'input')
                return true;
            if (name === undefined || !FOLDABLE_CALLS.has(name))
                return false;
            return inner.args.every((argument) => isCompileTimeConstant(checker, argument.value));
        }
        default:
            return false;
    }
}
/**
 * Whether a constant reads a setting as part of something larger, OS3025.
 *
 * `compiled-program.md` 2.3 gives a field fixed before bar 0 two forms: the
 * effective value, which the compiler folds, and `{ "input": "<key>" }`, one
 * setting resolved at load. `precision = input(2, "Decimals") + 1` and
 * `opacity = shade ? 1 : 0` are neither: the compiler cannot fold them, because
 * the setting's value is not known until the host resolves it, and the program
 * has no form for an expression evaluated at load. Nothing refused them, so the
 * emitter met them with no way to write them and reported a defect in itself.
 *
 * `wholeOnly` is false for an input's own options: a default, a bound or a
 * step is what the settings dialog shows before anybody has chosen, and a
 * setting that took its default from another setting would have none to show.
 */
export function readsInputInPart(checker, expression, wholeOnly) {
    if (!readsInput(checker, expression))
        return false;
    return !wholeOnly || !isWholeInput(checker, expression);
}
/** Whether a setting is read anywhere inside the expression. */
function readsInput(checker, expression) {
    if (isWholeInput(checker, expression))
        return true;
    const inner = withoutGrouping(expression);
    switch (inner.kind) {
        case 'arrayLiteral':
            return inner.elements.some((element) => readsInput(checker, element));
        case 'unary':
            return readsInput(checker, inner.operand);
        case 'binary':
            return readsInput(checker, inner.left) || readsInput(checker, inner.right);
        case 'ternary':
            return (readsInput(checker, inner.condition) ||
                readsInput(checker, inner.whenTrue) ||
                readsInput(checker, inner.whenFalse));
        case 'call':
            return inner.args.some((argument) => readsInput(checker, argument.value));
        default:
            return false;
    }
}
/** One setting and nothing else: an `input()` call, or a name that holds one. */
function isWholeInput(checker, expression) {
    const inner = withoutGrouping(expression);
    if (inner.kind === 'call')
        return calleeName(inner.callee) === 'input';
    if (inner.kind !== 'nameReference')
        return false;
    const binding = checker.lookup(inner.name);
    return binding !== undefined && inputHeldBy(binding) !== undefined;
}
/**
 * Whether the expression names one of the price series an `input` may default
 * to, `stdlib.md` 13.1.
 *
 * A source input is the one place a bar series stands where a constant is
 * otherwise required: `input(close, "Source")` does not read `close`, it names
 * which column the study is to read, and the host resolves that before bar 0
 * exactly as it resolves a number.
 */
export function isSourceName(expression) {
    const inner = withoutGrouping(expression);
    return inner.kind === 'nameReference' && BAR_SERIES.includes(inner.name);
}
function memberPath(object, member) {
    const inner = withoutGrouping(object);
    return inner.kind === 'nameReference' ? `${inner.name}.${member}` : member;
}
function calleeName(callee) {
    const inner = withoutGrouping(callee);
    if (inner.kind === 'nameReference')
        return inner.name;
    if (inner.kind === 'member') {
        const object = withoutGrouping(inner.object);
        if (object.kind === 'nameReference')
            return `${object.name}.${inner.member.text}`;
    }
    return undefined;
}
/** The dotted name a callee spells, or nothing when it is not a name at all. */
export function calleeNameOf(callee) {
    return calleeName(callee);
}
//# sourceMappingURL=constant.js.map