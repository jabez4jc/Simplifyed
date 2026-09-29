import { barField, factsFor } from './bars.js';
import { recordSource } from './bar-source.js';
import { Budget, stepBound } from './budget.js';
import { Channels } from './channels.js';
import { guardFor } from './guard.js';
import { Machine } from './machine.js';
import { NO_SESSION } from './session/index.js';
import { Memory } from './memory.js';
import { Registers } from './registers.js';
import { ABSENT, Heap, isRef, reference } from './values/index.js';
/**
 * The body's tables wearing a program's shape.
 *
 * A copy of the parent with nine fields replaced, rather than a second
 * declaration, so that the one thing the two share by design, the constant pool
 * and the manifest, is shared by construction and cannot drift.
 */
export function bodyProgram(parent, request) {
    const body = request.body;
    return {
        ...parent,
        frame: body.frame,
        series: body.series,
        cells: body.cells,
        states: body.states,
        functions: body.functions,
        callSites: body.callSites,
        loops: body.loops,
        code: body.code,
        requests: body.requests,
        debug: { ...parent.debug, pos: body.pos, fnPos: body.fnPos },
    };
}
export class RequestBody {
    parts;
    registers;
    memory;
    heap = new Heap();
    budget;
    machine;
    /** Requested bars that have closed, which is the index the next one takes. */
    settled = 0;
    /** Executions of the requested bar currently forming, for `bar.updates`. */
    touches = 0;
    /** The previous requested bar's close, which `trueRange` inside a body needs. */
    lastClose = null;
    /** The requested bars themselves, kept only when a read inside folds them. */
    history = [];
    historySource = recordSource(this.history);
    /**
     * The value the last closed requested bar handed back.
     *
     * Held so that the sweep does not reclaim it. A confirmed read takes the last
     * closed bucket's value on every chart bar of the next bucket, so the value
     * outlives the execution that produced it, and if it is an object the object
     * has to outlive it too.
     */
    handed = ABSENT;
    constructor(parts) {
        this.parts = parts;
        const { program } = parts;
        this.registers = new Registers(program.series.length);
        this.memory = new Memory(program.cells, program.states);
        this.budget = new Budget(parts.limits, parts.limits.steps ?? stepBound(program), program.limits.loops, parts.clock);
        const fnPositions = program.functions.map(() => []);
        for (const [fn, positions] of program.debug.fnPos)
            fnPositions[fn] = positions;
        this.machine = new Machine({
            program,
            registers: this.registers,
            memory: this.memory,
            // A read carries no channel, no plot and no declaration: those are the
            // calls the language refuses inside a request expression, so nothing in
            // a body can write a column and verification refuses an `EMIT` against
            // an empty table.
            channels: new Channels([]),
            heap: this.heap,
            budget: this.budget,
            guard: guardFor(this.budget),
            host: parts.host,
            position: parts.position,
            library: parts.library,
            fnPositions,
            spanAt: parts.spanAt,
        }, this.viewOf({ open: null, high: null, low: null, close: null, time: null }, 0, false));
    }
    /** How many requested bars have closed, which a warmup is counted against. */
    get closed() {
        return this.settled;
    }
    /** The body's own heap, which a read written inside it lands its value in. */
    get objects() {
        return this.heap;
    }
    /**
     * The requested bar still forming.
     *
     * Rolls back to the last closed bar first, so a bucket peeked on every chart
     * bar inside it costs one execution each and leaves no trace of the previous
     * one. Nothing is committed: the bucket is still moving.
     */
    peek(bar) {
        const value = this.execute(bar, false);
        this.touches += 1;
        return value;
    }
    /**
     * The requested bar has closed.
     *
     * The last execution of that bar is the one that counts, and the state it
     * leaves becomes the checkpoint the next bar starts from. `settle` is
     * idempotent only in the sense every checkpoint is: it is called once per
     * requested bar, by the one place that knows a bucket has ended.
     */
    settle(bar) {
        const value = this.execute(bar, true);
        this.handed = value;
        this.memory.commit();
        this.heap.commit();
        this.heap.sweep((visit) => {
            this.memory.walk(visit);
            this.registers.walk(visit);
            visit(this.handed);
        });
        this.registers.trim(this.settled, this.parts.program.limits.history);
        this.lastClose = bar.close ?? null;
        this.settled += 1;
        this.touches = 0;
        return value;
    }
    execute(bar, closed) {
        const index = this.settled;
        // Steps 1 and 2 of the bar cycle, one level down: the checkpoint from the
        // end of the previous requested bar, and the history entry this bar may
        // already have written.
        this.memory.rollback();
        this.heap.rollback();
        this.registers.truncate(index);
        this.registers.clearCurrent();
        this.budget.begin(index);
        const view = this.viewOf(bar, index, closed);
        this.machine.begin(view, index);
        const facts = factsFor(index, 
        // A bar that has closed is not the last one: something later is what
        // closed it. The one still forming is.
        index + (closed ? 2 : 1), { isConfirmed: closed }, this.touches === 0, this.touches + 1, NO_SESSION);
        for (const register of this.parts.program.series) {
            if (register.kind !== 'bar' || register.field === null)
                continue;
            this.registers.set(register.id, barField(register.field, bar, facts));
        }
        // A body is one expression with no statement to write a slot from, so a
        // setting it reads arrives as a register rather than as a slot (2.16.1).
        for (const input of this.parts.inputs)
            this.registers.set(input.series, input.value);
        const nested = this.parts.nested;
        if (nested !== undefined && !nested.empty) {
            this.history[index] = bar;
            nested.fill(this.registers, this.historySource, index, this.touches === 0);
        }
        this.machine.run();
        this.registers.close(index);
        return this.machine.result();
    }
    /**
     * A value the body produced, as a value of the machine that asked for it.
     *
     * A number, a string, a colour or absence is the same value in both, and
     * nothing is copied. An object is not: a reference is an index into one heap,
     * and the body's heap is its own, so handing the index over would name
     * whatever the other heap happens to hold at that index. So the object is
     * copied, and copied again on every bar that reads it, because the copy lives
     * in a heap whose rollback undoes the bar it was made on.
     *
     * Only an array can arrive here. A read that declared a grid or drew an object
     * is refused at the call (OS3006), so those two kinds cannot exist in a body.
     */
    carry(value, into) {
        return copyInto(value, this.heap, into, new Map());
    }
    viewOf(bar, index, closed) {
        return {
            index,
            open: bar.open ?? null,
            high: bar.high ?? null,
            low: bar.low ?? null,
            close: bar.close ?? null,
            volume: bar.volume ?? null,
            time: bar.time ?? null,
            previousClose: this.lastClose,
            isConfirmed: closed,
            isRealtime: false,
            isNew: this.touches === 0,
            isLast: !closed,
            updates: this.touches + 1,
            // The instrument record describes the chart's instrument, not the one a
            // read names, and a requested bar is not on the chart's own grid either.
            // So a body has no session, and it is told absence rather than false: a
            // false would say this bar closes no session, which is a claim about an
            // instrument whose hours the engine was never given.
            isSessionFirst: null,
            isSessionLast: null,
        };
    }
}
/**
 * One value copied from one heap into another, sharing what it shared.
 *
 * The map is what keeps two references to one array two references to one copy,
 * and it is what stops a value that refers to itself from recursing forever.
 */
function copyInto(value, from, into, copied) {
    if (!isRef(value))
        return value;
    const already = copied.get(value.id);
    if (already !== undefined)
        return reference(already);
    const object = from.get(value.id);
    if (object === undefined || object.kind !== 'array')
        return ABSENT;
    const items = [];
    const id = into.allocate({ kind: 'array', items });
    copied.set(value.id, id);
    for (const item of object.items)
        items.push(copyInto(item, from, into, copied));
    into.countElements(items.length);
    return reference(id);
}
//# sourceMappingURL=request-body.js.map