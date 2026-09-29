import { withoutGrouping } from '../ast/index.js';
import { libraryEntries } from '../check/index.js';
import { namedColour } from './colours.js';
import { arityOf, calleeText, effectOf } from './context.js';
import { emitExpression } from './expressions.js';
import { bodyFor } from './functions.js';
import { emitInputRead } from './inputs.js';
import { emitDeclarationCall } from './outputs.js';
import { registerOfName } from './registers.js';
import { REQUEST_CALLS, REQUEST_STATUS_CALLS, emitRequestRead, requestIdFor, } from './requests.js';
/** Whether a call leaves a value on the stack, which a statement has to pop. */
export function leavesValue(e, expression) {
    const node = withoutGrouping(expression);
    if (node.kind !== 'call')
        return true;
    const checked = e.callAt(node);
    const name = checked?.name ?? calleeText(node.callee);
    return !e.isDeclaration(name);
}
/**
 * Whether an expression is entirely one `input()` call.
 *
 * The declaration calls leave nothing on the stack, which is what `leavesValue`
 * answers, and `input()` is the one of them that also has a value to leave when
 * a value is what was asked for (`language.md` 13.4). One place needs the
 * narrower question: `var len = input(14, "Length")`, where the initialiser is
 * a value to put in a cell rather than a declaration the name stands for.
 */
export function isInputCall(e, expression) {
    const node = withoutGrouping(expression);
    return node.kind === 'call' && e.callAt(node)?.name === 'input';
}
export function emitCall(e, f, call) {
    const checked = e.callAt(call);
    if (checked === undefined || checked.target === 'unresolved') {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
        return;
    }
    if (e.isDeclaration(checked.name)) {
        // A declaration written as a statement of its own never arrives here:
        // `statements.ts` sends all three of its forms straight to the declaration
        // path. So an `input()` that reaches this point stands where a value
        // belongs, and the value is what it has to leave behind. `outputs.ts`
        // argues that split, which is the one this call is decided by.
        if (checked.name === 'input') {
            emitInputRead(e, f, call);
            return;
        }
        emitDeclarationCall(e, f, call, checked.name, undefined);
        return;
    }
    if (REQUEST_CALLS.has(checked.name)) {
        // One entry of `requests` and one register the engine fills, 2.16. The
        // expression argument is not emitted here: it belongs to the requested
        // bars, and emitting it inline would compute it on this chart's.
        emitRequestRead(e, f, call, checked);
        return;
    }
    if (checked.target === 'user' && checked.fn !== undefined) {
        emitUserCall(e, f, call, checked.fn, checked.arguments, checked.seriesArguments);
        return;
    }
    const entry = checked.entry;
    if (entry === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
        return;
    }
    emitLibraryCall(e, f, call, entry, checked.arguments);
}
/**
 * A library call: every argument in parameter order, then `CALL_LIB`.
 *
 * Named arguments, argument order and defaults are entirely a compile-time
 * matter (4.10), so an engine never sees a name, never consults a signature and
 * never holds a table of defaults. All three happen here.
 *
 * **An omitted argument is filled, not dropped.** It used to be emitted as
 * absent, because the surface recorded which parameters were optional and not
 * what each one defaulted to, and the cost of that was the whole reason this
 * paragraph exists: a lookback of an absent length answers absence on every
 * bar for ever, so `atr()` written exactly as `stdlib.md` prints it compiled
 * clean, loaded clean, ran to the last bar and drew nothing at all.
 *
 * **An order call carries one argument more than the surface shows.** For every
 * other call, filling a default is the whole of the job and the value is the
 * whole of the answer. For an order call it is not, because two of its defaults
 * are absence itself: `buy(qty = the declaration's, limit = none, stop = none)`.
 * An argument left out and an argument written that came out absent then reach
 * an engine as the same value, and `language.md` 6.8 gives them opposite
 * meanings: the first takes the documented default, and the second is a size or
 * a price nobody computed and is OS7002. `buy()` and `buy(qty = none)` compiled
 * to byte identical programs, so the refusal had nothing to fire on, and
 * `buy(qty = 1, stop = lowest(low, 20))`, which is the catalogue's own worked
 * example for OS7002, sent a market order on every bar of the window instead.
 *
 * So the last argument of an order call is the names of the arguments the
 * script wrote, in parameter order, separated by spaces. It is a value like any
 * other and the engine reads it like any other, which is why this needs no new
 * value, no new instruction and no change to the format: only the nine order
 * functions' manifest signatures, `compiled-program.md` 2.5 and 4.10.
 *
 * It is the last argument rather than the first because that is where a reader
 * of the program meets it after the arguments it describes, and it names the
 * arguments rather than numbering them so that a compiled program stays
 * readable by hand (2.14).
 */
function emitLibraryCall(e, f, call, entry, args) {
    const index = e.libraryFunction(entry);
    if (REQUEST_STATUS_CALLS.has(entry.name)) {
        emitReadHandle(e, f, call, args[0]?.value);
        f.builder.at(call.span);
        f.builder.push('CALL_LIB', index, arityOf(entry), -1);
        return;
    }
    const ordering = effectOf(entry) === 'order';
    const written = [];
    for (let i = 0; i < entry.parameters.length; i += 1) {
        const argument = args[i];
        const parameter = entry.parameters[i];
        if (argument !== undefined) {
            if (parameter !== undefined)
                written.push(parameter.name);
            emitExpression(e, f, argument.value);
            continue;
        }
        emitDefault(e, f, call, parameter, ordering);
    }
    if (ordering) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.string(written.join(' ')));
    }
    f.builder.at(call.span);
    const state = entry.stateful ? f.layout.state(index) : -1;
    f.builder.push('CALL_LIB', index, arityOf(entry), state);
}
/**
 * The argument a script left out, from the default its signature declares.
 *
 * A default is a value, and values are the emitter's: 4.10 puts named
 * arguments, argument order and defaults entirely at compile time. Most are a
 * constant. A handful are a name the compiler reads at the call instead, which
 * 4.10 also provides for: a default that is an expression rather than a literal
 * is compiled into the call site, and `vwap(src = hlc3)` is that case in a
 * library the specification writes as a table.
 *
 * A default that is neither is a defect in the surface and it blocks. Emitting
 * absence there is what produced a study with no values on any bar and nothing
 * reported anywhere, and a program that is not emitted is the honest form of
 * that. `scripts/check-defaults.mjs` is what stops it reaching here at all.
 */
function emitDefault(e, f, call, parameter, ordering) {
    f.builder.at(call.span);
    if (parameter === undefined || parameter.defaultText === undefined) {
        // The specification states no value for this argument: `leg = the only
        // leg` names the file's own declaration rather than a value the library
        // knows. Absence is what it carries, and whatever receives it decides.
        // Each one is recorded with its reason in `spec/default-exceptions.json`,
        // and nothing else may be in this state.
        //
        // On an order call this is not a gap. The call carries the names of the
        // arguments the script wrote, so absence here says "the script wrote
        // nothing" rather than "the value is unknown", and the engine applies the
        // default the specification states instead of guessing which it was.
        if (!ordering) {
            e.gap('an omitted optional argument is emitted as absent, because the specification states no ' +
                'value for it and names the declaration that decides instead', 'compiled-program.md 4.10, against stdlib.md section 1', call.span, false);
        }
        f.builder.push('CONST', e.pool.absent());
        return;
    }
    const value = defaultOf(parameter);
    const constant = value === undefined ? undefined : e.pool.of(value);
    if (constant !== undefined) {
        f.builder.push('CONST', constant);
        return;
    }
    if (emitNamedRead(e, f, parameter.defaultText))
        return;
    e.gap(`the library surface gives a default of \`${parameter.defaultText}\` which is neither a ` +
        "value of the parameter's type nor a library name that can be read, so there is nothing " +
        'to fill the argument with', 'compiled-program.md 4.10, against stdlib.md section 1', call.span, true);
    f.builder.push('CONST', e.pool.absent());
}
/**
 * The constant a default's text names, or nothing when it names no constant.
 *
 * Nothing is not a failure here: `hlc3` and `chart.timezone` are defaults the
 * specification states and neither is a literal of its parameter's type, so the
 * caller reads them instead. What this must never do is guess. A text that is
 * not a value of this type is not turned into one, because a value this
 * compiler invented would be indistinguishable, on the chart, from the value
 * the specification meant.
 *
 * A named colour stays a constant, unlike every other bare library name. That
 * is deliberate and it is the one place the two paths disagree: the channels
 * are settled here for a drawing's default and read from the manifest for a
 * colour a script wrote (`stdlib.md` 11.1). Reversing it would change programs
 * that are already compiled and compared byte for byte.
 */
function defaultOf(parameter) {
    const text = parameter.defaultText;
    if (text === undefined)
        return undefined;
    if (text === 'none')
        return { kind: 'absent' };
    switch (parameter.type.kind) {
        case 'bool':
            return text === 'true' || text === 'false'
                ? { kind: 'bool', value: text === 'true' }
                : undefined;
        case 'number': {
            const value = Number(text);
            return Number.isFinite(value) ? { kind: 'number', value } : undefined;
        }
        case 'string':
            return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
                ? { kind: 'string', value: text.slice(1, -1) }
                : undefined;
        case 'color': {
            const value = namedColour(text);
            return value === undefined ? undefined : { kind: 'colour', value };
        }
        default:
            return undefined;
    }
}
/**
 * The read `req.isReady` and `req.error` are asking about, as its id (2.16).
 *
 * The argument names a read rather than carrying one: a value on a bar cannot
 * say which request produced it, and the two calls answer about the request.
 * A name that holds no read is absent, which is what those two answer for a
 * read that does not exist; the checker takes any value here, so this is the
 * one place that can tell.
 */
function emitReadHandle(e, f, call, argument) {
    const id = argument === undefined ? undefined : requestIdFor(e, argument);
    f.builder.at(call.span);
    if (id === undefined) {
        e.gap('a read status call was given something that is not a name holding a read, and the ' +
            'signature admits any value, so there is no request for it to ask about', 'compiled-program.md 2.16, against stdlib.md 15.1', call.span, false);
        f.builder.push('CONST', e.pool.absent());
        return;
    }
    f.builder.push('CONST', e.pool.number(id));
}
/**
 * A call to a `fn`, and the registers the call site has to retain for it.
 *
 * A series argument is always given a fresh register, even when the argument is
 * a bare series name whose register already exists (4.10). Binding the existing
 * one would give the body history on bars where the call did not execute, which
 * would make a call inside an `if` behave differently from a call inside a
 * function inside an `if`.
 */
function emitUserCall(e, f, call, checkedFunction, args, seriesArguments) {
    const declared = e.checked.functions[checkedFunction];
    const parameters = declared?.parameters.length ?? args.length;
    const site = e.newSite(0, parameters);
    f.sites.push(site.index);
    site.series = new Array(parameters).fill(-1);
    // The body is emitted before the arguments are pushed, because the body is
    // what says which parameters need a register: a `HISTP` against a parameter
    // the call site bound `-1` is a corrupt program, and the checker can only
    // mark a parameter it was able to prove is a series (`language.md` 11.2).
    site.fn = bodyFor(e, checkedFunction, site);
    const retained = new Set(seriesArguments);
    for (const instruction of e.functions[site.fn]?.code ?? []) {
        if (instruction[0] === 'HISTP')
            retained.add(instruction[1] ?? 0);
    }
    for (let i = 0; i < parameters; i += 1) {
        const argument = args[i];
        if (argument === undefined) {
            // A parameter's own default is compiled into the call site rather than
            // into the body (4.10), and the tree carries it on the declaration.
            const fallback = declared?.declaration.parameters[i]?.defaultValue;
            if (fallback === undefined) {
                f.builder.at(call.span);
                f.builder.push('CONST', e.pool.absent());
            }
            else {
                emitExpression(e, f, fallback);
            }
        }
        else {
            emitExpression(e, f, argument.value);
        }
        if (!retained.has(i))
            continue;
        const register = e.layout.argument(declared?.parameters[i]?.name ?? `arg${i}`);
        site.series[i] = register;
        f.builder.at(call.span);
        f.builder.push('DUP');
        f.builder.push('SSTORE', register);
    }
    f.builder.at(call.span);
    f.builder.push('CALL_FN', site.index);
}
/**
 * A library value read without brackets: a bar series, a named colour, a fact
 * about the chart, the session or the position.
 *
 * Only a bar series is a register. Everything else is a value the host supplies
 * and the only instruction that can fetch one is a call of no arguments, so
 * that is what it compiles to and the engine's own manifest decides the value.
 * A named colour goes the same way deliberately: the exact channels are the
 * manifest's (`stdlib.md` 11.1), and a colour that reaches a bar should come
 * from there rather than from this compiler's stand-in table.
 */
export function emitLibraryValue(e, f, node) {
    const name = node.kind === 'nameReference' ? node.name : memberName(node);
    f.builder.at(node.span);
    if (emitNamedRead(e, f, name))
        return;
    f.builder.push('CONST', e.pool.absent());
}
/**
 * One bare library read, by name, or false when the name is not one.
 *
 * Two callers, and they are the same read: a name a script wrote, and a name a
 * signature gives as a default. A default that is an expression is compiled
 * into the call site (4.10), and for this library an expression is always one
 * of these names, so `vwap()` emits exactly what `vwap(hlc3)` emits rather than
 * something close to it. The caller positions the span before calling.
 */
function emitNamedRead(e, f, name) {
    const register = registerOfName(e, name);
    if (register !== undefined) {
        f.builder.push('SLOAD', register);
        return true;
    }
    const entry = libraryEntries(name).find((one) => !one.callable);
    if (entry === undefined)
        return false;
    const index = e.libraryFunction(entry);
    const state = entry.stateful ? f.layout.state(index) : -1;
    f.builder.push('CALL_LIB', index, 0, state);
    return true;
}
function memberName(node) {
    const object = withoutGrouping(node.object);
    return object.kind === 'nameReference' ? `${object.name}.${node.member.text}` : node.member.text;
}
//# sourceMappingURL=calls.js.map