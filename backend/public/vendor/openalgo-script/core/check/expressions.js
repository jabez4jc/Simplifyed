import { withoutGrouping } from '../ast/index.js';
import { resolveCall } from './call-sites.js';
import { warmupOfElement } from './call-warmup.js';
import { inputHeldBy } from './checked.js';
import { reportStrategyOnly } from './checker.js';
import { allowHandle, handleAllowed, refuseHandle } from './handles.js';
import { literalNumber } from './literals.js';
import { isNamespace, libraryEntries, membersOf } from './surface.js';
import { closestName } from './suggest.js';
import { BOOL, COLOR, NONE, NUMBER, STRING, UNKNOWN, arrayOf, canBeArrayElement, compatible, elementOf, isSeries, join, sameType, seriesOf, typeText, } from './types.js';
import { BAR_ZERO, NEVER, allOf, delayed, earlier, later, weaken } from './warmup.js';
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const COMPARISON = new Set(['<', '<=', '>', '>=']);
const EQUALITY = new Set(['==', '!=']);
/**
 * An expression, and the answer to whether it may stand where it was written.
 *
 * A declaration handle is the one type that is not a value (`language.md` 5.4),
 * so the type the pass works out is checked against the closed list of places
 * one may be written before it is handed to the rule above. Refusing here
 * rather than at each consumer is what makes the refusal hold for a position
 * nobody enumerated; `handles.ts` says why that matters.
 */
export function checkExpression(checker, expression, placement) {
    const type = checkNode(checker, expression, placement);
    if (type.kind !== 'handle' || handleAllowed(checker, expression))
        return type;
    return refuseHandle(checker, expression, type);
}
function checkNode(checker, expression, placement) {
    switch (expression.kind) {
        case 'numberLiteral':
            return checker.record(expression, NUMBER, BAR_ZERO);
        case 'stringLiteral':
            return checker.record(expression, STRING, BAR_ZERO);
        case 'booleanLiteral':
            return checker.record(expression, BOOL, BAR_ZERO);
        case 'colorLiteral':
            return checker.record(expression, COLOR, BAR_ZERO);
        case 'noneLiteral':
            return checker.record(expression, NONE, NEVER);
        case 'missingExpression':
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        case 'grouping': {
            const inner = checkExpression(checker, expression.expression, placement);
            return checker.record(expression, inner, checker.warmupOf(expression.expression));
        }
        case 'arrayLiteral':
            return checkArrayLiteral(checker, expression, placement);
        case 'nameReference':
            return checkNameReference(checker, expression);
        case 'member':
            return checkMember(checker, expression);
        case 'unary':
            return checkUnary(checker, expression, placement);
        case 'binary':
            return checkBinary(checker, expression, placement);
        case 'ternary': {
            checkCondition(checker, expression.condition, placement);
            const whenTrue = checkExpression(checker, expression.whenTrue, placement);
            const whenFalse = checkExpression(checker, expression.whenFalse, placement);
            // Both arms are one type, or one of them is `none` (language.md 9.5).
            if (!compatible(whenTrue, whenFalse)) {
                checker.report('OS2012', expression.span, {
                    leftType: typeText(whenTrue),
                    rightType: typeText(whenFalse),
                });
                return checker.record(expression, UNKNOWN, BAR_ZERO);
            }
            const warmup = weaken(earlier(checker.warmupOf(expression.whenTrue), checker.warmupOf(expression.whenFalse)));
            return checker.record(expression, join(whenTrue, whenFalse), warmup);
        }
        case 'call':
            return resolveCall(checker, expression, placement);
        case 'index':
            return checkIndex(checker, expression, placement);
    }
}
/**
 * A condition, `language.md` 6.6: `bool` or absent, and nothing else.
 *
 * There is no truthiness in this language. A zero is not false and an empty
 * string is not false, because every silent coercion rule anywhere is a source
 * of bugs that survive review, and a script that places orders is the last
 * place to want one.
 */
export function checkCondition(checker, condition, placement) {
    const type = checkExpression(checker, condition, placement);
    if (type.kind === 'unknown' || type.kind === 'none')
        return;
    if (elementOf(type).kind === 'bool')
        return;
    checker.report('OS2011', condition.span, {
        type: typeText(type),
        name: checker.textOf(condition.span),
    });
}
function checkArrayLiteral(checker, expression, placement) {
    // A handle may be named here so that the answer is OS2019, which says an
    // array cannot hold one and where to put the declaration instead
    // (`language.md` 5.4 and 14.1).
    const types = expression.elements.map((element) => {
        allowHandle(checker, element);
        return elementOf(checkExpression(checker, element, placement));
    });
    const warmup = allOf(expression.elements.map((element) => checker.warmupOf(element)));
    // An empty literal takes its element type from an annotation or from the
    // first insertion (language.md 14.1); until then it is unknown, and OS2015
    // is reported at the end of the check if nothing ever fixed it.
    if (types.length === 0)
        return checker.record(expression, arrayOf(UNKNOWN), BAR_ZERO);
    const first = types.find((one) => one.kind !== 'none' && one.kind !== 'unknown') ?? UNKNOWN;
    for (let i = 0; i < types.length; i += 1) {
        const other = types[i];
        if (other === undefined || other.kind === 'none' || other.kind === 'unknown')
            continue;
        if (sameType(first, other))
            continue;
        const element = expression.elements[i];
        checker.report('OS2013', element?.span ?? expression.span, {
            firstType: typeText(first),
            otherType: typeText(other),
            index: i,
        });
        // Unknown rather than an array of unknown, so the name this literal is
        // assigned to does not also collect OS2015 for a type nobody can supply.
        return checker.record(expression, UNKNOWN, warmup);
    }
    if (!canBeArrayElement(first)) {
        checker.report('OS2019', expression.span, { type: typeText(first) });
        return checker.record(expression, UNKNOWN, warmup);
    }
    return checker.record(expression, arrayOf(first), warmup);
}
function checkNameReference(checker, expression) {
    const binding = checker.lookup(expression.name);
    if (binding !== undefined) {
        if (binding.kind === 'function') {
            checker.report('OS2014', expression.span, { name: expression.name });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        // A request expression is compiled over another instrument's bars, so a
        // name computed on this chart's has no counterpart there (stdlib.md 15.4).
        // An input is a compile-time constant and is allowed; a `var` initialised
        // from one is not, because a later assignment may change it.
        if (checker.requestDepth > 0 &&
            inputHeldBy(binding) === undefined &&
            binding.kind !== 'parameter') {
            checker.report('OS6003', expression.span, { name: expression.name });
        }
        binding.isRead = true;
        checker.references.set(expression, binding);
        return checker.record(expression, binding.type, checker.warmupOfRead(binding));
    }
    const entries = libraryEntries(expression.name);
    const value = entries.find((one) => !one.callable);
    if (value === undefined) {
        if (entries.length > 0) {
            // A library function named bare: `ema` on its own is not a value.
            checker.report('OS2014', expression.span, { name: expression.name });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        checker.report('OS2001', expression.span, {
            name: expression.name,
            suggestion: checker.suggestionFor(expression.name),
        });
        return checker.record(expression, UNKNOWN, BAR_ZERO);
    }
    if (value.planned) {
        checker.report('OS2020', expression.span, { name: expression.name });
    }
    reportStrategyOnly(checker, expression.name, expression.span, value.strategyOnly);
    const warmup = value.warmup.kind === 'data' ? weaken(BAR_ZERO) : BAR_ZERO;
    return checker.record(expression, value.returns, warmup);
}
function checkMember(checker, expression) {
    const object = withoutGrouping(expression.object);
    const written = object.kind === 'nameReference' ? object.name : checker.textOf(object.span);
    const member = expression.member.text;
    const full = `${written}.${member}`;
    if (object.kind !== 'nameReference' || !isNamespace(written)) {
        checker.report('OS2009', expression.member.span, {
            namespace: written,
            member,
            suggestion: closestName(member, membersOf(written)),
        });
        return checker.record(expression, UNKNOWN, BAR_ZERO);
    }
    const entries = libraryEntries(full);
    const value = entries.find((one) => !one.callable);
    if (value === undefined) {
        if (entries.length > 0) {
            checker.report('OS2014', expression.span, { name: full });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        checker.report('OS2009', expression.member.span, {
            namespace: written,
            member,
            suggestion: closestName(member, membersOf(written)),
        });
        return checker.record(expression, UNKNOWN, BAR_ZERO);
    }
    if (value.planned) {
        checker.report('OS2020', expression.span, { name: full });
    }
    reportStrategyOnly(checker, full, expression.span, value.strategyOnly);
    const warmup = value.warmup.kind === 'data' ? weaken(BAR_ZERO) : BAR_ZERO;
    return checker.record(expression, value.returns, warmup);
}
function checkUnary(checker, expression, placement) {
    const operand = checkExpression(checker, expression.operand, placement);
    const warmup = checker.warmupOf(expression.operand);
    const element = elementOf(operand);
    const wrap = (type) => (isSeries(operand) ? seriesOf(type) : type);
    if (expression.operator === 'not') {
        if (element.kind !== 'bool' && element.kind !== 'none' && element.kind !== 'unknown') {
            checker.report('OS2011', expression.span, {
                type: typeText(operand),
                name: checker.textOf(expression.operand.span),
            });
            return checker.record(expression, UNKNOWN, warmup);
        }
        // `not none` is none (language.md 6.6), so absence carries through.
        return checker.record(expression, wrap(BOOL), warmup);
    }
    if (element.kind !== 'number' && element.kind !== 'none' && element.kind !== 'unknown') {
        checker.report('OS2003', expression.span, {
            leftType: typeText(NUMBER),
            rightType: typeText(operand),
        });
        return checker.record(expression, UNKNOWN, warmup);
    }
    return checker.record(expression, wrap(NUMBER), warmup);
}
function checkBinary(checker, expression, placement) {
    const left = checkExpression(checker, expression.left, placement);
    const right = checkExpression(checker, expression.right, placement);
    const leftWarmup = checker.warmupOf(expression.left);
    const rightWarmup = checker.warmupOf(expression.right);
    const series = isSeries(left) || isSeries(right);
    const wrap = (type) => (series ? seriesOf(type) : type);
    const a = elementOf(left);
    const b = elementOf(right);
    const soft = (type) => type.kind === 'none' || type.kind === 'unknown';
    if (ARITHMETIC.has(expression.operator)) {
        // `+` also concatenates two strings and does nothing else (language.md 9.2).
        const strings = expression.operator === '+' && (a.kind === 'string' || b.kind === 'string');
        const wanted = strings ? STRING : NUMBER;
        const fits = (type) => soft(type) || type.kind === wanted.kind;
        if (!fits(a) || !fits(b)) {
            checker.report('OS2003', expression.span, {
                leftType: typeText(left),
                rightType: typeText(right),
            });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        // Absence propagates through arithmetic (language.md 6.2), so the result
        // waits for both sides.
        return checker.record(expression, wrap(wanted), later(leftWarmup, rightWarmup));
    }
    if (COMPARISON.has(expression.operator)) {
        const ordered = (type) => soft(type) || type.kind === 'number' || type.kind === 'string';
        if (!ordered(a) || !ordered(b) || (!soft(a) && !soft(b) && a.kind !== b.kind)) {
            checker.report('OS2003', expression.span, {
                leftType: typeText(left),
                rightType: typeText(right),
            });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        if (isNoneLiteral(expression.left) || isNoneLiteral(expression.right)) {
            checker.report('OS8012', expression.span, { op: expression.operator });
        }
        // Absence propagates through ordering as well (language.md 6.4).
        return checker.record(expression, wrap(BOOL), later(leftWarmup, rightWarmup));
    }
    if (EQUALITY.has(expression.operator)) {
        if (!compatible(left, right)) {
            checker.report('OS2003', expression.span, {
                leftType: typeText(left),
                rightType: typeText(right),
            });
            return checker.record(expression, UNKNOWN, BAR_ZERO);
        }
        // Equality is total under absence (language.md 6.5): it answers on bar 0.
        return checker.record(expression, wrap(BOOL), BAR_ZERO);
    }
    const boolean = (type) => soft(type) || type.kind === 'bool';
    if (!boolean(a)) {
        checker.report('OS2011', expression.left.span, {
            type: typeText(left),
            name: checker.textOf(expression.left.span),
        });
        return checker.record(expression, UNKNOWN, BAR_ZERO);
    }
    if (!boolean(b)) {
        checker.report('OS2011', expression.right.span, {
            type: typeText(right),
            name: checker.textOf(expression.right.span),
        });
        return checker.record(expression, UNKNOWN, BAR_ZERO);
    }
    // `and` and `or` are three-valued and short-circuit (language.md 6.6 and
    // 9.4): one decisive operand settles the answer, so the earlier of the two
    // is a floor on when there is one, and it is only a floor.
    return checker.record(expression, wrap(BOOL), weaken(earlier(leftWarmup, rightWarmup)));
}
function isNoneLiteral(expression) {
    return withoutGrouping(expression).kind === 'noneLiteral';
}
/**
 * `a[i]`: history when `a` is a series, element access when it is an array.
 *
 * `language.md` 9.6 settles which at compile time from the type of `a`, so
 * there is no run-time dispatch. What has history at all is 5.2's list of four,
 * and `hasHistory` below is that list; anything else is OS2004, whose fix is to
 * give the value a name at the top level of the file.
 *
 * Neither kind of thing in 5.4 has history, and a name holding one of them sits
 * at the top level, which is why the two are refused by name here rather than
 * left to `hasHistory`: a handle has no per-bar value to retain, and an object
 * is one reference that the script mutates rather than a value per bar.
 */
function checkIndex(checker, expression, placement) {
    // A handle is allowed to be named here so that this reads it and says the
    // thing a reader needs, which is that it has no history; refusing it as a
    // value first would answer a question nobody asked.
    allowHandle(checker, expression.target);
    const target = checkExpression(checker, expression.target, placement);
    checkExpression(checker, expression.index, placement);
    const targetWarmup = checker.warmupOf(expression.target);
    if (target.kind === 'unknown')
        return checker.record(expression, UNKNOWN, targetWarmup);
    if (elementOf(target).kind === 'array') {
        const array = elementOf(target);
        const element = array.kind === 'array' ? array.element : UNKNOWN;
        const warmup = elementWarmup(checker, expression) ?? targetWarmup;
        return checker.record(expression, element, warmup);
    }
    const held = elementOf(target).kind;
    if (held === 'handle' || held === 'object' || !hasHistory(checker, expression.target, target)) {
        checker.report('OS2004', expression.span, {
            expr: checker.textOf(expression.target.span),
        });
        return checker.record(expression, UNKNOWN, targetWarmup);
    }
    markHistoryRead(checker, expression.target);
    const back = literalNumber(expression.index);
    // `x[n]` past the start of the dataset is absent, not an error (7.4), so the
    // value it reads is available n bars after the value itself is.
    const warmup = back === undefined ? weaken(targetWarmup) : delayed(targetWarmup, back);
    return checker.record(expression, elementOf(target), warmup);
}
/**
 * The warmup of one output of a multi-output call, where this reads one.
 *
 * `stdlib.md` 2.3 gives each element its own warmup, and the array's is the
 * earliest of them, so `m[1]` read through the array's would claim a value for
 * bars where the signal line is still absent and a read built on it would ask a
 * host for too little history. Nothing here when the index is not a written
 * number or the call states one warmup for every element: the array's is then
 * the element's, and the caller uses it.
 */
function elementWarmup(checker, expression) {
    const index = literalNumber(expression.index);
    if (index === undefined || !Number.isInteger(index) || index < 0)
        return undefined;
    const inner = withoutGrouping(expression.target);
    const call = inner.kind === 'call'
        ? checker.callSites.get(inner)
        : inner.kind === 'nameReference'
            ? checker.multiOutputOf(inner.name)
            : undefined;
    return call === undefined ? undefined : warmupOfElement(checker, call, index);
}
/** The four cases of language.md 5.2, and nothing else. */
function hasHistory(checker, target, type) {
    const inner = withoutGrouping(target);
    if (inner.kind === 'call' || inner.kind === 'member')
        return isSeries(type);
    if (inner.kind !== 'nameReference')
        return false;
    const binding = checker.lookup(inner.name);
    if (binding === undefined)
        return isSeries(type);
    if (binding.kind === 'file')
        return true;
    return binding.kind === 'parameter' && isSeries(binding.type);
}
/** Records that a name's past is read, which is what allocates it a register. */
function markHistoryRead(checker, target) {
    const inner = withoutGrouping(target);
    if (inner.kind !== 'nameReference')
        return;
    const binding = checker.lookup(inner.name);
    if (binding !== undefined)
        binding.readsHistory = true;
}
//# sourceMappingURL=expressions.js.map