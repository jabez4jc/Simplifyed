import { withoutGrouping } from '../ast/index.js';
import { bindArguments, arityText, signatureText } from './arguments.js';
import { warmupOfCall } from './call-warmup.js';
import { reportStrategyOnly } from './checker.js';
import { isCompileTimeConstant, readsInputInPart } from './constant.js';
import { refuseHandle } from './handles.js';
import { literalNumber, literalString } from './literals.js';
import { recordOutput, reportCallWarnings } from './outputs.js';
import { isTopLevelOnly, libraryEntries } from './surface.js';
import { closestName } from './suggest.js';
import { NOTHING, UNKNOWN, accepts, elementOf, isHandle, typeText } from './types.js';
import { BAR_ZERO } from './warmup.js';
/** The calls whose first argument is an array that an empty literal may fill. */
const INSERTERS = new Set(['push', 'unshift', 'insert', 'set']);
function shapesOf(entry) {
    return entry.parameters.map((one) => ({ name: one.name, optional: one.optional }));
}
/**
 * The signature a call means.
 *
 * With one candidate there is nothing to choose. With several, arity decides
 * first because it is the cheaper test and it separates most of the library's
 * overloads on its own; where two signatures take the same count, the written
 * positional arguments decide, which is `stdlib.md` 2.2's second rule.
 */
function selectOverload(checker, call, entries) {
    const callable = entries.filter((one) => one.callable);
    const first = callable[0];
    if (first === undefined || callable.length === 1)
        return first;
    const given = call.args.length;
    const byArity = callable.filter((one) => {
        const required = one.parameters.filter((p) => !p.optional).length;
        return given >= required && given <= one.parameters.length;
    });
    const narrowed = byArity.length === 0 ? callable : byArity;
    const only = narrowed[0];
    if (only === undefined || narrowed.length === 1)
        return only;
    const byType = narrowed.find((one) => call.args.every((argument, index) => {
        if (argument.label !== undefined)
            return true;
        const parameter = one.parameters[index];
        return parameter === undefined || accepts(parameter.type, checker.typeOf(argument.value));
    }));
    return byType ?? only;
}
/** Binds the stand-ins of a signature to the types the call actually supplied. */
function bindVariables(checker, entry, filled) {
    const bound = new Map();
    const remember = (name, type) => {
        const existing = bound.get(name);
        if (existing === undefined || existing.kind === 'none' || existing.kind === 'unknown') {
            bound.set(name, type);
        }
    };
    for (let i = 0; i < entry.parameters.length; i += 1) {
        const parameter = entry.parameters[i];
        const argument = filled[i];
        if (parameter === undefined || argument === undefined)
            continue;
        // A stand-in binds to the type it was given, and a declaration handle is
        // the one type it must not carry: a signature that returned one would hand
        // a name a handle the emitter has no declaration for (`language.md` 5.4).
        // `validateArguments` reports it; this keeps the result out of the tree.
        const supplied = checker.typeOf(argument.value);
        const given = supplied.kind === 'handle' ? UNKNOWN : supplied;
        const wanted = parameter.type;
        if (wanted.kind === 'variable')
            remember(wanted.name, given);
        else if (wanted.kind === 'array' && wanted.element.kind === 'variable') {
            const element = elementOf(given);
            if (element.kind === 'array')
                remember(wanted.element.name, element.element);
        }
    }
    return bound;
}
/**
 * Whether a parameter is written to take whatever it is given.
 *
 * A stand-in (`orElse(x: T, fallback: T)`) and `any` (`text(x: any)`) both name
 * no type, so a handle in one of them has no declared type to be named against
 * and OS3011 would have nothing to put in its sentence. What is true of both is
 * that they take a value, which is the answer OS2003 gives.
 */
function takesAnyValue(type) {
    switch (type.kind) {
        case 'variable':
        case 'unknown':
            return true;
        case 'array':
        case 'series':
            return takesAnyValue(type.element);
        default:
            return false;
    }
}
function substitute(type, bound) {
    switch (type.kind) {
        case 'variable':
            return bound.get(type.name) ?? UNKNOWN;
        case 'array':
            return { kind: 'array', element: substitute(type.element, bound) };
        case 'series':
            return { kind: 'series', element: substitute(type.element, bound) };
        default:
            return type;
    }
}
/** Every argument against the parameter it filled: type, value set, range, constancy. */
export function validateArguments(checker, entry, filled, bound) {
    for (let i = 0; i < entry.parameters.length; i += 1) {
        const parameter = entry.parameters[i];
        const argument = filled[i];
        if (parameter === undefined || argument === undefined)
            continue;
        const expected = substitute(parameter.type, bound);
        const given = checker.typeOf(argument.value);
        const span = argument.span;
        if (given.kind === 'nothing') {
            checker.report('OS2003', span, {
                leftType: typeText(expected),
                rightType: typeText(NOTHING),
            });
        }
        else if (entry.name === 'fill' && (i === 0 || i === 1)) {
            // `unknown` is what an expression already reported about carries, and it
            // satisfies everything, so a band drawn to a name whose own line was
            // refused does not collect a second diagnostic about the same mistake.
            if (given.kind !== 'unknown' && (given.kind !== 'handle' || given.handle !== 'plot')) {
                checker.report('OS3020', span, {
                    argument: parameter.name,
                    found: typeText(given),
                });
            }
        }
        else if (isHandle(given) && parameter.type.kind !== 'handle') {
            // `fill` is the one signature in version 1 that declares a handle
            // parameter, and it is answered above. Every other parameter takes a
            // value, including a stand-in, which binds to whatever it is given and
            // would otherwise carry a handle into a call that has no way to hold one.
            if (takesAnyValue(parameter.type)) {
                refuseHandle(checker, argument.value, given);
            }
            else if (expected.kind === 'object' || expected.kind === 'objects') {
                // A setter that takes a set of object kinds is the same case as one
                // that takes a single kind: the argument wanted a runtime object and a
                // declaration handle has no value on a bar. OS3019's own example is a
                // plot handle given to `draw.setColor`, which reached OS2003 while that
                // parameter was written `any`.
                checker.report('OS3019', span, {
                    name: entry.name,
                    argument: parameter.name,
                    expected: typeText(expected),
                    found: typeText(given),
                });
            }
            else {
                checker.report('OS3011', span, {
                    name: entry.name,
                    argument: parameter.name,
                    expected: typeText(expected),
                    found: typeText(given),
                });
            }
        }
        else if (!accepts(expected, given)) {
            checker.report('OS3011', span, {
                name: entry.name,
                argument: parameter.name,
                expected: typeText(expected),
                found: typeText(given),
            });
        }
        // OS3023. An argument that names something the file declares, in a release
        // where nothing can declare one. The value is not read and no suggestion is
        // offered, because there is no name that would have been right: what the
        // reader has to do is take the argument out. Refused whether the name was
        // written or computed, which is the whole difference from the set check
        // below: a computed leg was ignored exactly as quietly as a misspelt one,
        // and a script that named one leg and closed another traded the leg it did
        // not name.
        if (entry.undeclared.includes(parameter.name)) {
            checker.report('OS3023', span, { name: entry.name, argument: parameter.name });
        }
        const allowed = entry.values[parameter.name];
        const written = literalString(argument.value);
        if (allowed !== undefined && written !== undefined && !allowed.includes(written)) {
            checker.report('OS3008', span, {
                argument: parameter.name,
                values: allowed.join(', '),
                found: written,
                suggestion: closestName(written, allowed),
            });
        }
        const range = entry.whole[parameter.name];
        const value = range === undefined ? undefined : literalNumber(argument.value);
        if (range !== undefined && value !== undefined && !inRange(value, range.min, range.max)) {
            checker.report('OS3004', span, {
                name: entry.name,
                argument: parameter.name,
                range: range.text,
                found: value,
            });
        }
        if (entry.constant.includes(parameter.name)) {
            if (!isCompileTimeConstant(checker, argument.value)) {
                checker.report('OS3003', span, { option: parameter.name });
            }
            else if (readsInputInPart(checker, argument.value, entry.name !== 'input')) {
                checker.report('OS3025', span, { option: parameter.name });
            }
            else if (entry.written.includes(parameter.name) && readsInputInPart(checker, argument.value, false)) {
                checker.report('OS3026', span, { option: parameter.name });
            }
        }
    }
    reportConflicts(checker, entry, filled);
}
/**
 * OS3010: two arguments that state one thing two ways.
 *
 * Reconciling them would need a rule, and every rule anybody has proposed for
 * it surprises somebody, so both are refused and the script says which it
 * meant. The caret goes under the second of the two, which is the one the
 * reader is most likely to have added.
 */
function reportConflicts(checker, entry, filled) {
    for (const [first, second] of entry.conflicts) {
        const a = filled[entry.parameters.findIndex((one) => one.name === first)];
        const b = filled[entry.parameters.findIndex((one) => one.name === second)];
        if (a === undefined || b === undefined)
            continue;
        checker.report('OS3010', b.span, { first, second });
    }
}
function inRange(value, min, max) {
    if (!Number.isInteger(value))
        return false;
    if (min !== undefined && value < min)
        return false;
    return max === undefined || value <= max;
}
/**
 * An empty array literal taking its element type from the first insertion.
 *
 * `language.md` 14.1 gives an unannotated `[]` its type from the first `push`,
 * `unshift`, `insert` or `set` in source order, and this is that moment: the
 * checker is looking at the call, it knows which name the array came from, and
 * it knows what is being put in.
 */
function fixElementType(checker, entry, filled) {
    if (!INSERTERS.has(entry.name))
        return;
    const target = filled[0];
    const value = filled[filled.length - 1];
    if (target === undefined || value === undefined)
        return;
    const reference = withoutGrouping(target.value);
    if (reference.kind !== 'nameReference')
        return;
    const binding = checker.lookup(reference.name);
    if (binding === undefined)
        return;
    const current = elementOf(binding.type);
    if (current.kind !== 'array' || current.element.kind !== 'unknown')
        return;
    const element = elementOf(checker.typeOf(value.value));
    if (element.kind === 'unknown' || element.kind === 'none')
        return;
    binding.type = { kind: 'array', element };
}
/**
 * A call to a name the library holds.
 *
 * The result is recorded whether or not anything was reported about it, because
 * every stage above this one asks the same two questions of a call site, and a
 * hole in the map would make each of them invent an answer of its own.
 */
export function resolveLibraryCall(checker, call, name, placement) {
    const entries = libraryEntries(name);
    const entry = selectOverload(checker, call, entries);
    if (entry === undefined) {
        const held = entries[0];
        checker.report('OS2010', call.span, {
            name,
            type: held === undefined ? typeText(UNKNOWN) : typeText(held.returns),
            suggestion: checker.callSuggestionFor(name, call.args.map((one) => checker.textOf(one.span))),
        });
        return unresolved(call, name);
    }
    if (entry.planned) {
        checker.report('OS2020', call.span, { name });
    }
    reportStrategyOnly(checker, name, call.span, entry.strategyOnly);
    checkPlacement(checker, call, entry, placement);
    const shapes = shapesOf(entry);
    const filled = bindArguments(checker, call.span, call.args, name, shapes);
    const bound = bindVariables(checker, entry, filled);
    validateArguments(checker, entry, filled, bound);
    fixElementType(checker, entry, filled);
    const stateful = entry.stateful;
    if (stateful && checker.isConditional(call)) {
        checker.report('OS8001', call.span, { name });
    }
    const checked = {
        call,
        name,
        target: 'library',
        entry,
        fn: undefined,
        arguments: filled,
        returns: substitute(entry.returns, bound),
        warmup: warmupOfCall(checker, entry, filled),
        stateful,
        stateId: stateful ? checker.takeStateId() : undefined,
        seriesArguments: [],
    };
    remember(checker, checked);
    recordOutput(checker, entry, checked);
    reportCallWarnings(checker, entry, checked);
    return checked;
}
/** OS3006 and OS3007: a call that describes the file's shape, written inside it. */
function checkPlacement(checker, call, entry, placement) {
    if (!entry.topLevel || placement.topLevel)
        return;
    const construct = placement.construct ?? 'a block';
    if (entry.name === 'input')
        checker.report('OS3007', call.span, {});
    else if (isTopLevelOnly(entry.name)) {
        checker.report('OS3006', call.span, { name: entry.name, construct });
    }
}
export function unresolved(call, name) {
    return {
        call,
        name,
        target: 'unresolved',
        entry: undefined,
        fn: undefined,
        arguments: [],
        returns: UNKNOWN,
        warmup: BAR_ZERO,
        stateful: false,
        stateId: undefined,
        seriesArguments: [],
    };
}
export function remember(checker, checked) {
    checker.calls.push(checked);
    checker.callSites.set(checked.call, checked);
}
export { arityText, signatureText };
//# sourceMappingURL=calls.js.map