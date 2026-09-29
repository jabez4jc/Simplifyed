import { isObjectTypeName, isValueTypeName, typeAnnotationText, withoutGrouping } from '../ast/index.js';
import { literalNumber } from './literals.js';
import { checkCondition, checkExpression } from './expressions.js';
import { allowHandle } from './handles.js';
import { isLibraryName } from './surface.js';
import { HANDLE_KINDS, NUMBER, UNKNOWN, arrayOf, canBeArrayElement, compatible, elementOf, isDefinite, join, objectType, sameType, seriesOf, typeText, } from './types.js';
import { BAR_ZERO, earlier } from './warmup.js';
/** Runs a block's statements in a scope of their own, `language.md` 12.1. */
export function checkBlock(checker, block, placement) {
    checker.inScope('block', undefined, () => {
        checkStatements(checker, block.statements, placement);
    });
}
/** A run of statements, with the one thing that is about the run: reachability. */
export function checkStatements(checker, statements, placement) {
    let returned = false;
    for (const statement of statements) {
        if (statement.kind === 'functionDeclaration')
            continue;
        if (returned) {
            checker.report('OS8016', statement.span, {
                line: statement.span.line,
            });
            returned = false;
        }
        checkStatement(checker, statement, placement);
        if (statement.kind === 'returnStatement')
            returned = true;
    }
}
export function checkStatement(checker, statement, placement) {
    switch (statement.kind) {
        case 'versionLine':
        case 'scriptDeclaration':
        case 'limitsLine':
            // The header is read before anything else runs; see declaration.ts.
            return;
        case 'expressionStatement':
            // A declaration written for its effect, `plot(close, "C")`, is a call
            // whose result is a handle nobody named (`language.md` 5.4).
            if (withoutGrouping(statement.expression).kind === 'call') {
                allowHandle(checker, statement.expression);
            }
            checkExpression(checker, statement.expression, placement);
            return;
        case 'assignment':
            checkAssignment(checker, statement, placement);
            return;
        case 'varDeclaration':
            checkVar(checker, statement, placement);
            return;
        case 'ifStatement':
            checkIf(checker, statement, placement);
            return;
        case 'forRangeStatement':
            checkForRange(checker, statement, placement);
            return;
        case 'forInStatement':
            checkForIn(checker, statement, placement);
            return;
        case 'whileStatement':
            checkWhile(checker, statement, placement);
            return;
        case 'switchStatement':
            checkSwitch(checker, statement, placement);
            return;
        case 'breakStatement':
        case 'continueStatement':
            return;
        case 'returnStatement': {
            if (statement.value === undefined)
                return;
            const type = checkExpression(checker, statement.value, placement);
            checker.pendingReturns.push({ type, warmup: checker.warmupOf(statement.value) });
            return;
        }
    }
}
/** The placement inside a construct, for OS3006's message. */
function inside(placement, construct, loop = false) {
    return {
        topLevel: false,
        construct,
        inLoop: placement.inLoop || loop,
    };
}
function checkAssignment(checker, statement, placement) {
    const target = statement.target;
    // `upper = plot(...)` names a declaration, which is the one assignment a
    // handle may stand in (`language.md` 5.4). A second name for a handle that
    // already has one is not a declaration and has nothing to store, so only the
    // call itself is allowed here.
    if (statement.operator === '=' && withoutGrouping(statement.value).kind === 'call') {
        allowHandle(checker, statement.value);
    }
    const type = checkExpression(checker, statement.value, placement);
    const warmup = checker.warmupOf(statement.value);
    if (checker.loopVariableNamed(target.text)) {
        checker.report('OS2006', target.span, { name: target.text });
        return;
    }
    const { binding: existing, crossedFunction } = checker.lookupAcross(target.text);
    if (existing !== undefined) {
        if (crossedFunction) {
            checker.report('OS2002', target.span, {
                name: target.text,
                line: existing.declaredAt.line,
            });
            return;
        }
        checker.targets.set(target, existing);
        updateType(checker, target, existing.type, type, (fixed) => {
            existing.type = fixed;
        });
        existing.warmup = earlier(existing.warmup, warmup);
        checker.holdsMultiOutput(existing.id, callHeldBy(checker, statement.value));
        return;
    }
    // A built-in lives in the global scope, so assigning to one is a shadowing
    // attempt and is OS2002 (language.md 12.4).
    if (isLibraryName(target.text)) {
        checker.report('OS2002', target.span, { name: target.text, line: 'built-in' });
        return;
    }
    if (statement.operator !== '=') {
        checker.report('OS2001', target.span, {
            name: target.text,
            suggestion: checker.suggestionFor(target.text),
        });
    }
    const kind = checker.scope === checker.fileScope ? 'file' : 'block';
    const binding = checker.declare(target, kind, type, warmup);
    const inner = withoutGrouping(statement.value);
    checker.holdsMultiOutput(binding.id, callHeldBy(checker, statement.value));
    if (inner.kind === 'call') {
        const call = checker.callSites.get(inner);
        if (call?.name === 'input')
            adoptInput(checker, binding.id, target.text);
        if (type.kind === 'handle')
            binding.handle = type.handle;
    }
}
/** The library call a name is being given, where it is given one directly. */
function callHeldBy(checker, value) {
    const inner = withoutGrouping(value);
    return inner.kind === 'call' ? checker.callSites.get(inner) : undefined;
}
/**
 * Gives the input the name it was assigned to, which is also its default title.
 *
 * Called from both spellings that put a name in front of an `input()`, because
 * the key is what the row is stored under and a `var` does not rename a row.
 * Whether the name then *is* the input, which decides its slot and whether a
 * declaration option may fold it, is the separate question `inputHeldBy` asks.
 */
function adoptInput(checker, bindingId, name) {
    const input = checker.inputs[checker.inputs.length - 1];
    const binding = checker.bindings[bindingId];
    if (input === undefined || binding === undefined)
        return;
    input.name = name;
    if (input.title === '')
        input.title = name;
    binding.input = input.id;
}
/**
 * The rule of `language.md` 10.1: the first definite assignment fixes the type.
 *
 * `none` is a member of every type, so an assignment of `none` carries nothing
 * to fix a type with and the name waits for the next one. A name that is never
 * given a definite type is of type `none`, which is legal wherever `none` is.
 */
function updateType(checker, target, current, given, fix) {
    if (!isDefinite(given))
        return;
    if (!isDefinite(current)) {
        fix(given);
        return;
    }
    if (!sameType(current, given)) {
        checker.report('OS2003', target.span, {
            leftType: typeText(current),
            rightType: typeText(given),
        });
        return;
    }
    fix(join(current, given));
}
function checkVar(checker, statement, placement) {
    const initial = checkExpression(checker, statement.initialiser, placement);
    const annotated = statement.annotation === undefined
        ? undefined
        : resolveAnnotation(checker, statement.annotation);
    const name = statement.name;
    const enclosing = checker.enclosing(name.text);
    if (enclosing !== undefined) {
        checker.report('OS2002', name.span, { name: name.text, line: enclosing.declaredAt.line });
    }
    else if (isLibraryName(name.text)) {
        checker.report('OS2002', name.span, { name: name.text, line: 'built-in' });
    }
    else if (checker.scope.names.has(name.text)) {
        const existing = checker.scope.names.get(name.text);
        checker.report('OS2002', name.span, {
            name: name.text,
            line: existing?.declaredAt.line ?? name.span.line,
        });
    }
    let type = annotated ?? initial;
    if (annotated !== undefined && isDefinite(initial) && !sameType(annotated, initial)) {
        checker.report('OS2003', statement.span, {
            leftType: typeText(annotated),
            rightType: typeText(initial),
        });
        type = annotated;
    }
    const kind = checker.scope === checker.fileScope ? 'file' : 'block';
    const binding = checker.declare(name, kind, type, checker.warmupOf(statement.initialiser), statement.live ? 'live' : 'var');
    // `var len = input(14, "Length")` declares one settings row like any other,
    // and the name it is written under is that row's key and its label
    // (`host-interface.md` 8.1). What `var` decides is where the value lives, not
    // what the row is called, so adding or removing the word leaves a user's
    // stored value on the row they stored it for. The name does not become the
    // input: `inputHeldBy` is where that half is answered.
    const written = withoutGrouping(statement.initialiser);
    if (written.kind === 'call' && checker.callSites.get(written)?.name === 'input') {
        adoptInput(checker, binding.id, name.text);
    }
    if (statement.live)
        checker.report('OS8011', name.span, { name: name.text });
}
/** A type as written, `language.md` 5.1 and 14.1. OS2016 and OS2019 live here. */
export function resolveAnnotation(checker, annotation) {
    switch (annotation.kind) {
        case 'namedType': {
            if (isValueTypeName(annotation.name))
                return { kind: annotation.name };
            if (isObjectTypeName(annotation.name))
                return objectType(annotation.name);
            checker.report('OS2016', annotation.span, { type: typeAnnotationText(annotation) });
            return UNKNOWN;
        }
        case 'seriesType':
            return seriesOf(resolveAnnotation(checker, annotation.element));
        case 'arrayType': {
            // A declaration handle and a series are refused here rather than being
            // resolved first, because OS2016 would say the word is not a type and it
            // is: the answer the reader needs is that an array cannot hold one.
            const written = typeAnnotationText(annotation.element);
            const handle = HANDLE_KINDS.includes(written);
            if (handle || annotation.element.kind === 'seriesType') {
                checker.report('OS2019', annotation.span, { type: written });
                return UNKNOWN;
            }
            const element = resolveAnnotation(checker, annotation.element);
            if (!canBeArrayElement(element)) {
                checker.report('OS2019', annotation.span, { type: written });
                return UNKNOWN;
            }
            return arrayOf(element);
        }
    }
}
function checkIf(checker, statement, placement) {
    for (const branch of statement.branches) {
        checkCondition(checker, branch.condition, placement);
        reportConstantCondition(checker, branch.condition);
        checkBlock(checker, branch.body, inside(placement, 'an if block'));
    }
    if (statement.elseBranch !== undefined) {
        checkBlock(checker, statement.elseBranch.body, inside(placement, 'an else block'));
    }
}
function reportConstantCondition(checker, condition) {
    const inner = withoutGrouping(condition);
    if (inner.kind !== 'booleanLiteral')
        return;
    checker.report('OS8017', condition.span, { value: String(inner.value) });
}
function checkForRange(checker, statement, placement) {
    checkNumeric(checker, statement.from, placement);
    checkNumeric(checker, statement.to, placement);
    if (statement.step !== undefined)
        checkNumeric(checker, statement.step, placement);
    const from = literalNumber(statement.from);
    const to = literalNumber(statement.to);
    const step = statement.step === undefined ? 1 : literalNumber(statement.step);
    if (statement.step !== undefined && step === 0) {
        checker.report('OS3004', statement.step.span, {
            name: 'for',
            argument: 'step',
            range: 'other than zero',
            found: 0,
        });
    }
    else if (from !== undefined && to !== undefined && step !== undefined && step !== 0) {
        const runs = step > 0 ? from <= to : from >= to;
        if (!runs) {
            checker.report('OS8015', statement.span, { start: from, end: to, step });
        }
    }
    runLoop(checker, statement.variable, NUMBER, statement.body, placement);
}
function checkForIn(checker, statement, placement) {
    const iterable = checkExpression(checker, statement.iterable, placement);
    const array = elementOf(iterable);
    if (array.kind !== 'array' && array.kind !== 'unknown') {
        checker.report('OS2003', statement.iterable.span, {
            leftType: typeText(arrayOf(UNKNOWN)),
            rightType: typeText(iterable),
        });
    }
    const element = array.kind === 'array' ? array.element : UNKNOWN;
    runLoop(checker, statement.variable, element, statement.body, placement);
}
/** The loop variable's scope is the body's, and assigning to it is OS2006. */
function runLoop(checker, variable, type, body, placement) {
    const enclosing = checker.lookup(variable.text);
    if (enclosing !== undefined) {
        checker.report('OS2002', variable.span, {
            name: variable.text,
            line: enclosing.declaredAt.line,
        });
    }
    else if (isLibraryName(variable.text)) {
        checker.report('OS2002', variable.span, { name: variable.text, line: 'built-in' });
    }
    checker.inScope('block', variable.text, () => {
        checker.declare(variable, 'loop', type, BAR_ZERO);
        checkStatements(checker, body.statements, inside(placement, 'a loop body', true));
    });
}
function checkWhile(checker, statement, placement) {
    checkCondition(checker, statement.condition, placement);
    checkBlock(checker, statement.body, inside(placement, 'a loop body', true));
}
function checkNumeric(checker, expression, placement) {
    const type = checkExpression(checker, expression, placement);
    if (elementOf(type).kind === 'number' || !isDefinite(type))
        return;
    checker.report('OS2003', expression.span, {
        leftType: typeText(NUMBER),
        rightType: typeText(type),
    });
}
/**
 * `switch` in both forms of `language.md` 10.6.
 *
 * With a subject, each case value is compared against it and has to be its
 * type. Without one, each case value is a condition and has to be a bool. The
 * absent subject is the whole difference between the two forms.
 */
function checkSwitch(checker, statement, placement) {
    const subject = statement.subject === undefined
        ? undefined
        : checkExpression(checker, statement.subject, placement);
    for (const arm of statement.cases) {
        for (const value of arm.values) {
            if (subject === undefined) {
                checkCondition(checker, value, placement);
                continue;
            }
            const type = checkExpression(checker, value, placement);
            if (!compatible(subject, type)) {
                checker.report('OS2003', value.span, {
                    leftType: typeText(subject),
                    rightType: typeText(type),
                });
            }
        }
        checkBlock(checker, arm.body, inside(placement, 'a case arm'));
    }
    if (statement.defaultCase !== undefined) {
        checkBlock(checker, statement.defaultCase.body, inside(placement, 'a default arm'));
    }
}
//# sourceMappingURL=statements.js.map