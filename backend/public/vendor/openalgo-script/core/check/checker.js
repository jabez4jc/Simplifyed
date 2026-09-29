import { namesGivenAValue } from './assigned.js';
import { conditionalCalls } from './conditional.js';
import { libraryFunctionNames, libraryNames } from './surface.js';
import { closestName } from './suggest.js';
import { UNKNOWN } from './types.js';
import { BAR_ZERO, weaken } from './warmup.js';
export const TOP_LEVEL = {
    topLevel: true,
    construct: undefined,
    inLoop: false,
};
export class Checker {
    file;
    sink;
    script;
    /** The file scope, which is also where a `fn` puts its name. */
    fileScope;
    scope;
    declaration = undefined;
    inputs = [];
    outputs = [];
    functions = [];
    bindings = [];
    calls = [];
    requests = [];
    types = new Map();
    warmups = new Map();
    /**
     * The expressions a declaration handle is allowed to stand in, 5.4.
     *
     * `handles.ts` holds the rule and fills this. It is a set of permissions
     * rather than a flag on the pass, because the permission belongs to one
     * written expression: `fill(upper, lower)` may name a handle, and an
     * expression inside one of those arguments may not.
     */
    handleSites = new Set();
    references = new Map();
    targets = new Map();
    callSites = new Map();
    /**
     * The multi-output call a name holds, by binding, for `m[1]`.
     *
     * A warmup is recorded against an expression, and an element's warmup is not
     * a fact about the array expression: it is a fact about the call the name was
     * given, which `m[1]` has to reach two statements later. Only the calls whose
     * outputs warm up at different bars are kept, because for every other one the
     * array's warmup is already the element's.
     */
    multiOutputs = new Map();
    /** The declarations of every `fn`, collected before any body is checked. */
    functionsByName = new Map();
    functionNodes = new Map();
    /** Bodies already checked, and the ones being checked, so a cycle stops. */
    checkedFunctions = new Set();
    checkingFunctions = new Set();
    repaints = false;
    stateCount = 0;
    /** How deep inside a `req` expression the pass is, `stdlib.md` 15.4. */
    requestDepth = 0;
    /** The function whose body is being checked, for its own statefulness. */
    currentFunction = undefined;
    /** What the body being checked returns, gathered as the `return`s are met. */
    pendingReturns = [];
    /** Every call site a bar can pass without evaluating, `language.md` 11.4. */
    conditional;
    /**
     * The names some line gives a value, read before a `var` is called never.
     *
     * Built the first time it is asked for, because it is one walk of the whole
     * tree and almost every file never reads a `var` that is still never.
     */
    givenAValue = undefined;
    constructor(file, script, sink) {
        this.file = file;
        this.script = script;
        this.sink = sink;
        this.fileScope = { kind: 'file', names: new Map(), parent: undefined, loopVariable: undefined };
        this.scope = this.fileScope;
        this.conditional = conditionalCalls(script);
    }
    /**
     * Whether this call site can be skipped on a bar, which is what OS8001 asks.
     *
     * Asked of the call rather than of the pass that reached it, so the answer is
     * the same wherever the call was written: inside an `if`, in a ternary arm,
     * or on the right of an `and` that short-circuited.
     */
    isConditional(call) {
        return this.conditional.has(call);
    }
    report(code, span, values) {
        this.sink.report(code, span, values);
    }
    /** The source text a span covers, for the codes that quote what was written. */
    textOf(span) {
        return this.file.text.slice(span.offset, span.offset + span.length).trim();
    }
    /** Opens a scope, runs the body in it, and closes it however the body ends. */
    inScope(kind, loopVariable, body) {
        const parent = this.scope;
        this.scope = { kind, names: new Map(), parent, loopVariable };
        try {
            return body();
        }
        finally {
            this.scope = parent;
        }
    }
    /**
     * The declaration a name means here, and whether a function body stands
     * between the two.
     *
     * A plain assignment updates an enclosing name (`language.md` 12.2), and a
     * function body is the one place that does not hold: 12.3's own example makes
     * an assignment to a file-scope name from inside a `fn` OS2002.
     */
    lookupAcross(name) {
        let crossedFunction = false;
        for (let scope = this.scope; scope !== undefined; scope = scope.parent) {
            const found = scope.names.get(name);
            if (found !== undefined)
                return { binding: found, crossedFunction };
            if (scope.kind === 'function')
                crossedFunction = true;
        }
        return { binding: undefined, crossedFunction };
    }
    /** The declaration a name means here, or nothing when no scope holds it. */
    lookup(name) {
        for (let scope = this.scope; scope !== undefined; scope = scope.parent) {
            const found = scope.names.get(name);
            if (found !== undefined)
                return found;
        }
        return undefined;
    }
    /** Whether an enclosing scope already holds the name, which is OS2002. */
    enclosing(name) {
        for (let scope = this.scope.parent; scope !== undefined; scope = scope.parent) {
            const found = scope.names.get(name);
            if (found !== undefined)
                return found;
        }
        return undefined;
    }
    /** Whether the name belongs to the loop being executed, `language.md` 10.3. */
    loopVariableNamed(name) {
        for (let scope = this.scope; scope !== undefined; scope = scope.parent) {
            if (scope.loopVariable === name)
                return true;
            if (scope.names.has(name))
                return false;
        }
        return false;
    }
    /** Declares a name in the current scope and records it in the checked tree. */
    declare(name, kind, type, warmup, persistence = 'none') {
        const binding = {
            id: this.bindings.length,
            name: name.text,
            kind,
            persistence,
            type,
            warmup,
            storage: storageFor(kind, persistence),
            declaredAt: name.span,
            readsHistory: false,
            isRead: false,
            input: undefined,
            handle: undefined,
        };
        this.bindings.push(binding);
        this.scope.names.set(name.text, binding);
        this.targets.set(name, binding);
        return binding;
    }
    /**
     * Remembers, or forgets, the multi-output call a name was just given.
     *
     * Forgetting on a reassignment rather than keeping the first call is what
     * stops `m[1]` from being answered about a call the name no longer holds:
     * the array's own warmup is the fallback, and it is a floor for every
     * element.
     */
    holdsMultiOutput(binding, call) {
        if (call === undefined || call.entry === undefined || call.entry.elements.length === 0) {
            this.multiOutputs.delete(binding);
            return;
        }
        this.multiOutputs.set(binding, call);
    }
    /** The multi-output call this name holds here, when it holds one. */
    multiOutputOf(name) {
        const binding = this.lookup(name);
        return binding === undefined ? undefined : this.multiOutputs.get(binding.id);
    }
    record(expression, type, warmup) {
        this.types.set(expression, type);
        this.warmups.set(expression, warmup);
        return type;
    }
    typeOf(expression) {
        return this.types.get(expression) ?? UNKNOWN;
    }
    /**
     * The warmup a read of this name sees, here.
     *
     * A `var` that is still never at this line but that a later line gives a
     * value is not never: the later line wrote it on the bar before, or on an
     * earlier pass of the same loop. The honest answer is a floor of bar 0,
     * which claims nothing and withdraws the claim OS8009 is built on, where an
     * exact bar would need the later line's warmup before it has been read.
     */
    warmupOfRead(binding) {
        if (binding.warmup.kind !== 'never' || binding.persistence === 'none')
            return binding.warmup;
        this.givenAValue ??= namesGivenAValue(this.script);
        return this.givenAValue.has(binding.name) ? weaken(BAR_ZERO) : binding.warmup;
    }
    warmupOf(expression) {
        return this.warmups.get(expression) ?? BAR_ZERO;
    }
    /** Every name a reader could have meant here: the scopes, then the library. */
    namesInScope() {
        const names = new Set();
        for (let scope = this.scope; scope !== undefined; scope = scope.parent) {
            for (const name of scope.names.keys())
                names.add(name);
        }
        for (const name of libraryNames())
            names.add(name);
        return [...names];
    }
    suggestionFor(written) {
        return closestName(written, this.namesInScope());
    }
    /**
     * OS2010's suggestion: the closest function, called with what was written.
     *
     * The catalogue documents the slot as the library function whose name is
     * closest, with its first argument filled in, so `volume(20)` is offered a
     * function over `volume` and the arguments the reader already wrote,
     * rather than a name that cannot be called either.
     */
    callSuggestionFor(written, args) {
        const inStrategy = this.declaration?.form === 'strategy';
        const name = closestName(written, libraryFunctionNames(inStrategy));
        return `${name}(${[written, ...args].join(', ')})`;
    }
    /** A state region for one call site, `compiled-program.md` 2.11. */
    takeStateId() {
        const id = this.stateCount;
        this.stateCount += 1;
        return id;
    }
    finish() {
        return {
            script: this.script,
            declaration: this.declaration,
            inputs: this.inputs,
            outputs: this.outputs,
            functions: this.functions,
            bindings: this.bindings,
            calls: this.calls,
            requests: this.requests,
            repaints: this.repaints,
            stateCount: this.stateCount,
            types: this.types,
            warmups: this.warmups,
            references: this.references,
            targets: this.targets,
            callSites: this.callSites,
        };
    }
}
/**
 * OS7001: a name the library gives only to a file declared with `strategy()`.
 *
 * The message names the line of the `study()` declaration rather than the call,
 * because that is the line the reader has to change: the call is what they
 * meant, and the declaration is what refuses it.
 */
export function reportStrategyOnly(checker, name, span, strategyOnly) {
    const declaration = checker.declaration;
    if (!strategyOnly || declaration === undefined || declaration.form === 'strategy')
        return;
    checker.report('OS7001', span, { name, line: declaration.node.span.line });
}
/**
 * Where a name's value lives between bars.
 *
 * A top-level name starts in a slot and is moved to a register only when the
 * program turns out to read its history, which the checker knows by the end and
 * `finaliseStorage` applies. Everything below the top level is a slot, and a
 * `var` is a cell whatever scope it was written in.
 */
function storageFor(kind, persistence) {
    if (persistence !== 'none')
        return 'cell';
    return kind === 'library' || kind === 'function' ? 'none' : 'slot';
}
/**
 * Promotes the top-level names whose history is read to series registers.
 *
 * `compiled-program.md` 2.10 allocates a register only for a name the program
 * reads the past of, and this is the one place that decides it, once every read
 * in the file has been seen.
 */
export function finaliseStorage(checker) {
    for (const binding of checker.bindings) {
        if (binding.readsHistory && binding.kind === 'file' && binding.persistence === 'none') {
            binding.storage = 'register';
        }
    }
}
//# sourceMappingURL=checker.js.map