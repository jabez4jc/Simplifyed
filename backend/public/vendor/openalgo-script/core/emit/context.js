import { withoutGrouping } from '../ast/index.js';
import { inputHeldBy } from '../check/index.js';
import { CodeBuilder } from './code.js';
import { GapLog } from './gaps.js';
import { FrameLayout, Layout } from './layout.js';
import { ConstantPool } from './pool.js';
import { fold } from './values.js';
/**
 * The calls that declare part of the file's fixed shape and compile to no
 * `CALL_LIB` at all.
 *
 * This is the split the format turns on. A `plot` call is an entry in
 * `outputs.plots` plus one `EMIT` per bar; `input` is a row of the settings
 * dialog and an engine writing a slot at step 5; `table` is a declared grid.
 * None of them is a function an engine calls, so none of them belongs in
 * `lib.functions`, whose only purpose is to be named by a `CALL_LIB` (2.5).
 */
/**
 * The calls that declare part of the file rather than computing anything.
 *
 * None of them is a `CALL_LIB`, so none of them is in the engine's library
 * manifest and none of them can be looked for there. The list is exported so a
 * test that asks which names an engine has to implement can subtract these
 * rather than carry a second copy of them.
 */
export const DECLARATION_CALLS = new Set([
    'plot',
    'plotCandles',
    'fill',
    'level',
    'table',
    'input',
    'signal',
    'alert',
    'barColor',
    'background',
]);
/** The frame a pass is emitting into: the top level, or one function body. */
export class Frame {
    layout = new FrameLayout();
    builder = new CodeBuilder();
    loops = [];
    /** Sites created while emitting this frame, in the order they were created. */
    sites = [];
    /** A parameter's position, for `HISTP`, by the binding that declared it. */
    parameters = new Map();
    topLevel;
    constructor(topLevel) {
        this.topLevel = topLevel;
    }
}
export class Emitter {
    pool;
    layout = new Layout();
    gaps;
    libraryFunctions;
    /** The signature behind each entry, which is what `requires` is derived from. */
    calledEntries;
    sites = [];
    functions = [];
    functionPos = [];
    loops = [];
    /** A frame per emitted function entry, for the cell and state base walk. */
    functionFrames = [];
    /**
     * File-scope names given a register although nothing reads their history.
     *
     * A slot belongs to one frame, so a name a function body reads has to live
     * somewhere every frame can address; `registers.ts` is where that is decided.
     */
    promoted = new Set();
    /** Cells and input slots carrying a register beside them, kept in step per bar. */
    shadowed = new Set();
    /**
     * Cells a function body reads, whose register is kept in step within the bar.
     *
     * A cell operand is relative to its own frame (2.11, 3.3), so a body has no
     * instruction that reaches a file-scope `var`. A register is addressed the
     * same way from every frame, so the value goes in one beside the cell: read
     * from the cell at the start of the bar, written again at every assignment,
     * so a body called at any point in the bar reads what the cell holds then.
     */
    carried = new Set();
    /** Bodies being emitted, so a call graph with a cycle in it stops (11.4). */
    emitting = new Set();
    /**
     * The file's fixed shape, filled in source order as the declarations are met.
     *
     * Source order is declaration order is legend order, so nothing sorts these
     * afterwards: the script already decided, and a second decision here would be
     * a second answer (2.8).
     */
    plots = [];
    fills = [];
    levels = [];
    markers = [];
    tables = [];
    alerts = [];
    inputs = [];
    barColor = null;
    background = null;
    /** The plot key a declaration handle holds, so `fill` can name two of them. */
    handleKeys = new Map();
    /** Names holding a declaration handle, which lives where the declaration put it. */
    handles = new Set();
    /** The reads of 2.16, and the request a name holding one came from. */
    requests = [];
    requestOf = new Map();
    /** The register one read's value lands in, so one call asks one question. */
    requestSeries = new Map();
    /**
     * The read whose expression is being emitted, when this emitter is one.
     *
     * An expression inside a read is compiled over other bars, so it gets an
     * emitter of its own rather than a flag on a frame: its registers, its cells
     * and its state regions are counted from zero on the requested bars, and a
     * pass that read the parent's would emit a program that computes this
     * chart's numbers under another chart's name.
     */
    request;
    libraryIndex;
    /** A leaf body, which calls no user function, is shared by every call site. */
    sharedBodies = new Map();
    file;
    checked;
    sink;
    options;
    constructor(file, checked, sink, options, parent, request) {
        this.file = file;
        this.checked = checked;
        this.sink = sink;
        this.options = options;
        // A read's body shares the constant pool and the library manifest, because
        // neither holds anything that depends on a bar, and one of each is one
        // table for an engine to verify rather than one per read (2.16).
        this.pool = parent?.pool ?? new ConstantPool();
        this.gaps = parent?.gaps ?? new GapLog();
        this.libraryFunctions = parent?.libraryFunctions ?? [];
        this.calledEntries = parent?.calledEntries ?? [];
        this.libraryIndex = parent?.libraryIndex ?? new Map();
        this.request = request;
    }
    /** An emitter for one read's expression, sharing what does not depend on a bar. */
    forRequest(request) {
        return new Emitter(this.file, this.checked, this.sink, this.options, this, request);
    }
    /** The checker's answer for one call, which the emitter never re-derives. */
    callAt(call) {
        return this.checked.callSites.get(call);
    }
    /** The declaration a name means, from the checker's own resolution. */
    bindingAt(reference) {
        return this.checked.references.get(reference);
    }
    /** The input one `input()` call declares, from the checker's own table. */
    inputAt(call) {
        return this.checked.inputs.find((one) => one.call === call);
    }
    /** Whether a call is a declaration rather than something an engine calls. */
    isDeclaration(name) {
        return DECLARATION_CALLS.has(name);
    }
    /**
     * The index of a library function in `lib.functions`, adding it on first use.
     *
     * `state` and `effect` are recorded beside the name because 2.5 requires them
     * and because they are facts an engine already knows: they are there to be
     * disagreed with at load, which is how a program compiled against a newer
     * library is caught before it computes a wrong number.
     */
    libraryFunction(entry) {
        // Keyed by name and arity, because a name may carry two signatures: `clear`
        // empties an array or a grid and the two are separate entries (stdlib 2.2).
        const key = `${entry.name}/${entry.parameters.length}`;
        const found = this.libraryIndex.get(key);
        if (found !== undefined)
            return found;
        const index = this.libraryFunctions.length;
        this.libraryFunctions.push({
            name: entry.name,
            arity: arityOf(entry),
            state: entry.stateful,
            effect: effectOf(entry),
        });
        this.calledEntries.push(entry);
        this.libraryIndex.set(key, index);
        return index;
    }
    newSite(fn, argc) {
        const site = {
            index: this.sites.length,
            fn,
            argc,
            cellBase: 0,
            stateBase: 0,
            series: [],
            frame: undefined,
            children: [],
        };
        this.sites.push(site);
        return site;
    }
    newLoop(kind, span) {
        const id = this.loops.length;
        this.loops.push({ id, kind, line: span.line, col: span.column });
        return id;
    }
    /** A body that calls no user function is one entry however many sites reach it. */
    shareableBody(checkedFunction) {
        return this.sharedBodies.get(checkedFunction);
    }
    rememberShareableBody(checkedFunction, emitted) {
        this.sharedBodies.set(checkedFunction, emitted);
    }
    gap(what, specification, span, blocking) {
        this.gaps.add({ what, specification, span, blocking });
    }
    /**
     * The value an expression has before bar 0, or nothing when it has none.
     *
     * The environment is built here because folding needs two answers only the
     * checker has: which declaration a name means, and which signature a call
     * resolved to with its arguments already in parameter order.
     */
    fold(expression) {
        return fold(expression, this.foldEnvironment());
    }
    foldEnvironment() {
        return {
            name: (reference) => {
                const binding = this.bindingAt(reference);
                if (binding === undefined)
                    return undefined;
                const held = inputHeldBy(binding);
                if (held === undefined)
                    return undefined;
                const input = this.checked.inputs[held];
                return input === undefined ? undefined : { kind: 'input', key: inputKey(input) };
            },
            call: (call) => {
                const checked = this.callAt(call);
                if (checked === undefined || checked.target !== 'library')
                    return undefined;
                return { name: checked.name, args: checked.arguments };
            },
            input: (call) => {
                const input = this.inputAt(call);
                return input === undefined ? undefined : { kind: 'input', key: inputKey(input) };
            },
        };
    }
}
/**
 * The key one input is known by: `inputs[].key`, and what a `{ "input": key }`
 * field names (2.3 and 2.6).
 *
 * Here rather than beside the table it keys, because three places name an
 * input by key and a second spelling of this would be a field that points at
 * no row.
 *
 * **Never the input's position.** `host-interface.md` 8.1 promises a key
 * "survives every edit that does not rename it", and a positional key keeps
 * that promise for no edit at all: inserting one tunable above another moves
 * every key below it, and a value a user stored against the third row lands on
 * the fourth, silently, because both are numbers and 8.3 has nothing to refuse.
 * An input written where a value belongs is assigned to no name, so its key is
 * its title, which is what the user sees and what changing is the rename 8.1
 * allows to lose a value. The two cannot collide: two inputs sharing a title
 * are OS3017, a title spelling another input's name is OS3022, and a title
 * that is not there at all is OS3021, so a key of `""` here is a program the
 * checker has already refused.
 */
export function inputKey(input) {
    return input.name === '' ? input.title : input.name;
}
/**
 * Which of the five effects a library call carries, `compiled-program.md` 2.5
 * and 5.4.
 *
 * The rule an entry is read by rather than a list of names, because a list in a
 * second place is a list that drifts. A call with an effect does not perform it
 * when it executes: it appends a record and **pushes absent as its result**. So
 * a call whose result a script uses cannot carry one, and that single sentence
 * settles every case in version 1.
 *
 * `order` is every call that spends money: `strategyOnly`, written with
 * brackets, and returning nothing. A `pos.*` reading is not one, because it is
 * read bare; `order.qtyForRisk` is not one, because it returns a number the
 * script goes on to size an order with.
 *
 * `log` is `print`, which reaches a log outside the machine.
 *
 * `draw` and `signal` are not reachable in version 1 and the emitter says so
 * rather than guessing. A drawing object lives in the object heap, which rolls
 * back with everything else (6.1), so a drawing needs no deferral to be
 * idempotent on a moving bar; a table cell is written to a per-bar output
 * buffer that is committed with the columns (2.8); and a marker and an alert
 * reach the host through a channel declared `defer`, not through a call.
 */
export function effectOf(entry) {
    if (entry.name === 'print')
        return 'log';
    if (entry.strategyOnly && entry.callable && entry.returns.kind === 'nothing')
        return 'order';
    return 'none';
}
/**
 * The arguments a `CALL_LIB` pushes for one entry, which is its `arity` (2.5).
 *
 * The same for every entry but the order functions, which carry one argument
 * more than the language surface shows: the names of the arguments the script
 * wrote. `calls.ts` says why an order call needs it and no other call does.
 *
 * Stated here rather than at the two places that need it, because the count the
 * program records and the count the instruction pushes disagreeing is a program
 * no engine will load.
 */
export function arityOf(entry) {
    return entry.parameters.length + (effectOf(entry) === 'order' ? 1 : 0);
}
/** The argument written for one parameter of a resolved call, or nothing. */
export function argumentAt(checked, entry, name) {
    const index = entry.parameters.findIndex((one) => one.name === name);
    return index < 0 ? undefined : checked.arguments[index];
}
/**
 * Every top-level name and the expression it is given, in source order.
 *
 * Two passes need it before any instruction is emitted: one to find the names
 * that hold a declaration handle, and one to find the names that hold a read.
 * Both have to answer about a name written below the line that asks, so both
 * run over the file rather than over what has been emitted so far.
 */
export function declaredNames(e) {
    const found = [];
    for (const item of e.checked.script.items) {
        if (item.kind === 'assignment') {
            found.push({ name: item.target, value: item.value, persistent: false });
        }
        else if (item.kind === 'varDeclaration') {
            found.push({ name: item.name, value: item.initialiser, persistent: true });
        }
    }
    return found;
}
/** The dotted name a callee spells, for a call the checker did not resolve. */
export function calleeText(expression) {
    const inner = withoutGrouping(expression);
    if (inner.kind === 'nameReference')
        return inner.name;
    if (inner.kind === 'member') {
        const object = withoutGrouping(inner.object);
        if (object.kind === 'nameReference')
            return `${object.name}.${inner.member.text}`;
    }
    return '';
}
//# sourceMappingURL=context.js.map