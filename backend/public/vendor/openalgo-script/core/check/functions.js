import { walk } from '../ast/index.js';
import { TOP_LEVEL } from './checker.js';
import { calleeNameOf } from './constant.js';
import { checkExpression } from './expressions.js';
import { checkStatements, resolveAnnotation } from './statements.js';
import { isLibraryName } from './surface.js';
import { UNKNOWN, isDefinite, join, sameType, typeText } from './types.js';
import { BAR_ZERO, earlier } from './warmup.js';
/** Registers every `fn` in the file, so a call above one still resolves. */
function collectFunctions(checker, script) {
    for (const item of script.items) {
        if (item.kind !== 'functionDeclaration')
            continue;
        const name = item.name.text;
        const existing = checker.functionNodes.get(name);
        if (existing !== undefined) {
            checker.report('OS2017', item.name.span, { name, line: existing.span.line });
            continue;
        }
        if (isLibraryName(name)) {
            checker.report('OS2002', item.name.span, { name, line: 'built-in' });
            continue;
        }
        const id = checker.functions.length;
        checker.functionNodes.set(name, item);
        checker.functionsByName.set(name, id);
        checker.functions.push({
            id,
            declaration: item,
            parameters: [],
            returns: UNKNOWN,
            warmup: BAR_ZERO,
            stateful: false,
        });
        checker.declare(item.name, 'function', UNKNOWN, BAR_ZERO);
    }
}
/** Every function this one calls, read off its body without checking anything. */
function calleesOf(declaration, known) {
    const found = new Set();
    walk(declaration, {
        enter(node) {
            if (node.kind !== 'call')
                return;
            const name = calleeNameOf(node.callee);
            if (name !== undefined && known.has(name))
                found.add(name);
        },
    });
    return found;
}
/**
 * OS2005: a function that reaches itself.
 *
 * A depth first walk that meets a name already on its own stack has found a
 * cycle, and the stack from that name back to itself is the chain the message
 * quotes, because a three function cycle is not something a reader can see from
 * one line. The walk runs over every declaration, including the ones nothing
 * ever calls, so a cycle is reported whether or not the file uses it.
 */
function detectRecursion(checker) {
    const known = new Set(checker.functionNodes.keys());
    const callees = new Map();
    for (const [name, declaration] of checker.functionNodes) {
        callees.set(name, calleesOf(declaration, known));
    }
    const done = new Set();
    const stack = [];
    const reported = new Set();
    const visit = (name) => {
        const cycle = stack.indexOf(name);
        if (cycle >= 0) {
            const chain = [...stack.slice(cycle), name];
            const start = chain[0] ?? name;
            if (!reported.has(start)) {
                reported.add(start);
                const declaration = checker.functionNodes.get(start);
                checker.report('OS2005', declaration?.name.span ?? checker.script.span, {
                    name: start,
                    cycle: chain.join(' calls '),
                });
            }
            return;
        }
        if (done.has(name))
            return;
        stack.push(name);
        for (const callee of callees.get(name) ?? [])
            visit(callee);
        stack.pop();
        done.add(name);
    };
    for (const name of checker.functionNodes.keys())
        visit(name);
}
/**
 * Checks a body once, the first time anything needs to know what it returns.
 *
 * A body is checked in the file scope rather than wherever the call was
 * written, because a function's enclosing scope is the file whatever line calls
 * it, and it is checked on demand rather than up front because the file-scope
 * names it can see are the ones declared above the call (`language.md` 12.5).
 */
export function ensureChecked(checker, id) {
    const fn = checker.functions[id];
    if (fn === undefined)
        return;
    if (checker.checkedFunctions.has(id) || checker.checkingFunctions.has(id))
        return;
    checker.checkingFunctions.add(id);
    const outer = checker.scope;
    checker.scope = checker.fileScope;
    try {
        checkBody(checker, id, fn.declaration);
    }
    finally {
        checker.scope = outer;
        checker.checkingFunctions.delete(id);
        checker.checkedFunctions.add(id);
    }
}
/** Collects every declaration and reports any cycle among them, before the file runs. */
export function checkFunctionDeclarations(checker, script) {
    collectFunctions(checker, script);
    detectRecursion(checker);
}
/** The bodies nothing called, so an unused helper still gets its diagnostics. */
export function checkRemainingFunctions(checker) {
    for (const id of checker.functionsByName.values())
        ensureChecked(checker, id);
}
function checkBody(checker, id, declaration) {
    const fn = checker.functions[id];
    if (fn === undefined)
        return;
    const firstBinding = checker.bindings.length;
    const firstCall = checker.calls.length;
    const outerReturns = checker.pendingReturns;
    checker.pendingReturns = [];
    const result = checker.inScope('function', undefined, () => {
        const parameters = declareParameters(checker, declaration);
        fn.parameters = parameters;
        return runBody(checker, declaration.body);
    });
    const returns = checker.pendingReturns;
    checker.pendingReturns = outerReturns;
    // A function holds state when its body does, whether the body wrote a `var`
    // or called something that keeps one (language.md 11.4).
    const heldVar = checker.bindings
        .slice(firstBinding)
        .some((one) => one.persistence !== 'none');
    const heldCall = checker.calls.slice(firstCall).some((one) => one.stateful);
    fn.stateful = heldVar || heldCall;
    let type = result.type;
    let warmup = result.warmup;
    for (const one of returns) {
        if (isDefinite(one.type) && isDefinite(type) && !sameType(type, one.type)) {
            checker.report('OS2003', declaration.span, {
                leftType: typeText(type),
                rightType: typeText(one.type),
            });
            continue;
        }
        type = join(type, one.type);
        warmup = earlier(warmup, one.warmup);
    }
    fn.returns = type;
    fn.warmup = warmup;
}
/** The parameters, in a scope of the body's own, `language.md` 11.2 and 12.3. */
function declareParameters(checker, declaration) {
    const bindings = [];
    const seen = new Set();
    for (const parameter of declaration.parameters) {
        const name = parameter.name.text;
        if (seen.has(name)) {
            checker.report('OS2018', parameter.name.span, { name });
            continue;
        }
        seen.add(name);
        const enclosing = checker.enclosing(name);
        if (enclosing !== undefined) {
            checker.report('OS2002', parameter.name.span, {
                name,
                line: enclosing.declaredAt.line,
            });
        }
        else if (isLibraryName(name)) {
            checker.report('OS2002', parameter.name.span, { name, line: 'built-in' });
        }
        const annotated = parameter.annotation === undefined
            ? undefined
            : resolveAnnotation(checker, parameter.annotation);
        const fromDefault = parameter.defaultValue === undefined
            ? undefined
            : checkExpression(checker, parameter.defaultValue, TOP_LEVEL);
        // Without an annotation the type is inferred from use (language.md 11.2).
        // Version 1 of this checker infers only from a default value and otherwise
        // leaves the parameter open, which reports nothing it cannot prove.
        const type = annotated ?? fromDefault ?? UNKNOWN;
        bindings.push(checker.declare(parameter.name, 'parameter', type, BAR_ZERO));
    }
    return bindings;
}
/**
 * Inside a function body, which both spellings of one are.
 *
 * The single line form used to be checked as though it stood at the top level,
 * and the placement is what OS3006 and OS3007 read: `fn f(x) => x + input(3,
 * "K")` declared a settings row from inside a function, which `language.md`
 * 13.4 forbids in as many words, and nothing said so. The two forms are the
 * same construct written two ways and a rule that holds for one holds for both.
 */
const INSIDE_A_BODY = {
    topLevel: false,
    construct: 'a function body',
    inLoop: false,
};
/**
 * A body and what it gives back.
 *
 * The single line form is one expression. The indented form ends in a bare
 * expression, which is its value, and a body that ends in something else
 * returns `none` unless a `return` ran (`language.md` 11.3).
 */
function runBody(checker, body) {
    if (body.kind !== 'block') {
        const type = checkExpression(checker, body, INSIDE_A_BODY);
        return { type, warmup: checker.warmupOf(body) };
    }
    checkStatements(checker, body.statements, INSIDE_A_BODY);
    const last = body.statements[body.statements.length - 1];
    if (last === undefined || last.kind !== 'expressionStatement') {
        return { type: UNKNOWN, warmup: BAR_ZERO };
    }
    return { type: checker.typeOf(last.expression), warmup: checker.warmupOf(last.expression) };
}
//# sourceMappingURL=functions.js.map