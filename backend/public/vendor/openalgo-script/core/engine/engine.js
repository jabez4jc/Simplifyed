import { barField, barViewOf, factsFor } from './bars.js';
import { alertsFor } from './alerts.js';
import { Budget, stepBound } from './budget.js';
import { Channels } from './channels.js';
import { ScriptError, spanAt, unexpected } from './errors.js';
import { guardFor } from './guard.js';
import { hostFactsFor } from './host.js';
import { fieldValue } from './inputs.js';
import { manifestEntry } from './library/index.js';
import { Machine } from './machine.js';
import { Memory } from './memory.js';
import { Registers } from './registers.js';
import { Grids } from './grids.js';
import { ledgerFor, routedEffects } from './orders.js';
import { NO_SESSION, sessionReader } from './session/index.js';
import { handOver, noBars } from './series.js';
import { KnownBars, sourceOf } from './bar-source.js';
import { barMinutesOf } from './timeframe.js';
import { RequestSet } from './requests.js';
import { Heap, storedValue } from './values/index.js';
import { drawingsIn } from './drawings.js';
export class Engine {
    registers;
    memory;
    channels;
    heap = new Heap();
    budget;
    machine;
    library = [];
    grids;
    onUnconfirmed;
    alerting;
    requests;
    /**
     * What this strategy sent and what became of it, `stdlib.md` 17.7. Held by
     * the run rather than asked of the host, because a host's position row is per
     * contract and shared: reading it is reading somebody else's trade.
     */
    ledger;
    /**
     * The instrument's session, read once from the record it belongs to.
     *
     * Once because the record is read once, at load, and is constant for the
     * whole run (`host-interface.md` 4.4). A session that changed between bar ten
     * and bar eleven would anchor the first ten bars of a study to one schedule
     * and the rest of the same chart to another.
     */
    sessions;
    /**
     * The bars the engine has been given, which a read folds.
     *
     * A read of the chart's own instrument at a coarser interval is folded from
     * these, so the fold needs the bars themselves and not only the registers
     * derived from them. `run` seeds the whole dataset before bar 0 and `append`
     * adds one at a time, which is the difference a `"lookahead"` read shows and
     * the other two modes do not: lookahead reads to the end of the bucket the
     * chart bar is inside, and on a live feed there is nothing there yet. That is
     * the mode repainting on history, permanently and by design.
     */
    known = new KnownBars();
    supplied = 0;
    index = -1;
    updates = 0;
    started = false;
    previousClose = null;
    lastClose = null;
    facts;
    view;
    failure;
    program;
    inputs;
    options;
    constructor(program, inputs, options, limits, plans = []) {
        this.program = program;
        this.inputs = inputs;
        this.options = options;
        this.registers = new Registers(program.series.length);
        this.memory = new Memory(program.cells, program.states);
        this.channels = new Channels(program.channels);
        this.budget = new Budget(limits, limits.steps ?? stepBound(program), program.limits.loops, options.clock);
        this.onUnconfirmed = fieldValue(program.meta.onUnconfirmed, inputs) === true;
        // A watched condition's title and frequency are declaration fields, which a
        // script may write with an `input()`, and inputs are resolved at load. So
        // they are read once here rather than per bar, as every other declaration
        // the descriptor is built from is.
        this.alerting = alertsFor(program, inputs);
        for (const entry of program.lib.functions) {
            // Verification refused a name this engine does not have, so the lookup
            // cannot fail here and the table is resolved once rather than per call.
            this.library.push(manifestEntry(entry.name, entry.arity));
        }
        const instrument = options.host?.instrument;
        this.sessions = sessionReader(instrument?.session, typeof instrument?.timezone === 'string' ? instrument.timezone : null, barMinutesOf(instrument?.interval));
        const facts = hostFactsFor(() => this.options.host ?? {}, {
            answered: (id) => this.requests.answered(id),
            failure: (id) => this.requests.failure(id),
        });
        this.ledger = ledgerFor(program, inputs, instrument);
        const position = {
            size: () => this.ledger.size(),
            avgPrice: () => this.ledger.avgPrice(),
        };
        this.facts = factsFor(0, 1, {}, true, 1, NO_SESSION);
        this.view = barViewOf({ open: null, high: null, low: null, close: null, time: null }, this.facts, null);
        const fnPositions = program.functions.map(() => []);
        for (const [fn, positions] of program.debug.fnPos)
            fnPositions[fn] = positions;
        this.machine = new Machine({
            program,
            registers: this.registers,
            memory: this.memory,
            channels: this.channels,
            heap: this.heap,
            budget: this.budget,
            guard: guardFor(this.budget),
            host: facts,
            position,
            library: this.library,
            fnPositions,
            spanAt: (line, column) => spanAt(options.source, line, column),
        }, this.view);
        this.requests = new RequestSet({
            program,
            plans: new Map(plans.map((one) => [one.request.id, one])),
            host: options.host ?? {},
            limits,
            clock: options.clock,
            library: this.library,
            inputs,
            facts,
            position,
            heapOf: () => this.heap,
            spanAt: (line, column) => spanAt(options.source, line, column),
        }, program.requests);
        this.grids = new Grids(program, inputs, this.heap);
    }
    /** Whether a failure has stopped this script. A stopped script stays stopped. */
    get failed() {
        return this.failure !== undefined;
    }
    /** How many bars the engine has been given. */
    get barCount() {
        return this.supplied;
    }
    /**
     * A new bar arrives.
     *
     * Step 11 of the previous bar happens here rather than at the end of it,
     * because a checkpoint is taken only if the engine is moving on to the next
     * bar, and until one arrives the previous bar may still be re-executed.
     */
    append(bar, state = {}, supplied = this.supplied + 1) {
        // Before anything moves: a bar that does not follow the one before it is
        // refused rather than executed, because every value the bar produces would
        // be derived from a history that never happened (`series.ts`). A script
        // that has already failed keeps the failure it has, which is the one that
        // explains what went wrong first.
        if (this.failure === undefined) {
            const problem = handOver(bar, this.known.at(this.index), this.index + 1);
            if (problem !== undefined)
                return this.refuse(problem);
        }
        if (this.started)
            this.checkpoint();
        this.index += 1;
        this.supplied = Math.max(supplied, this.index + 1);
        this.updates = 1;
        this.started = true;
        this.previousClose = this.lastClose;
        if (this.known.length <= this.index)
            this.known.set(this.index, bar);
        return this.execute(bar, state, true);
    }
    /**
     * The newest bar changed, so it runs again.
     *
     * Step 1: the checkpoint from the end of the previous bar is restored, except
     * that `"live"` cells keep their current values, which is the whole of
     * `live var`. Everything else rolls back, so executing a moving bar ten times
     * gives the same answer as executing it once.
     */
    update(bar, state = {}) {
        if (!this.started)
            return this.append(bar, state);
        // A revision is the same bar again, so it is held to the same order: an
        // update whose time has moved back onto the bar before it is a series the
        // engine cannot run on, whatever it is called.
        if (this.failure === undefined) {
            const problem = handOver(bar, this.known.at(this.index - 1), this.index);
            if (problem !== undefined)
                return this.refuse(problem);
        }
        this.rollback();
        this.updates += 1;
        // A revision replaces the bar the fold already read, so the bucket it is
        // inside is rebuilt from this reading rather than from the one it replaced.
        this.known.set(this.index, bar);
        return this.execute(bar, state, false);
    }
    /**
     * A whole dataset, appended in order. Stops at the first bar that fails.
     *
     * The whole set is handed to the fold before bar 0 rather than discovered one
     * bar at a time. Nothing about a confirmed or a developing read changes: both
     * stop at the bar being executed, so running a dataset and appending it bar by
     * bar give the same numbers. A `"lookahead"` read is the one that differs, and
     * that difference is the mode: it reads to the end of the bucket the chart bar
     * is inside, which exists in a dataset and does not exist on a live feed.
     *
     * A dataset with nothing in it is OS6010 and not an empty result, because a
     * pane with nothing drawn on it is what a study that computed nothing also
     * produces and only the engine can tell the two apart.
     */
    run(bars, states = []) {
        const source = sourceOf(bars);
        const out = [];
        // No bars at all is answered here: the loop below would return an empty, wordless result.
        if (source.length === 0 && !this.started) {
            const diagnostic = this.failure ?? noBars(this.options.host?.instrument);
            this.failure = diagnostic;
            return { bars: [], diagnostic };
        }
        this.known.reset(source);
        for (let i = 0; i < source.length; i += 1) {
            const bar = source.at(i);
            if (bar === undefined)
                continue;
            const result = this.append(bar, states[i] ?? {}, source.length);
            out.push(result);
            if (result.diagnostic !== undefined)
                return { bars: out, diagnostic: result.diagnostic };
        }
        return { bars: out, diagnostic: undefined };
    }
    /**
     * The dataset a driver appends one bar at a time, handed to the fold before
     * bar 0 as `run` hands it, so a `"lookahead"` read reads it as history.
     */
    history(bars) {
        if (!this.started)
            this.known.reset(sourceOf(bars));
    }
    /**
     * A frame from the destination, `host-interface.md` 7.2. Held until the next
     * bar begins rather than folded where it lands: nothing reaches a running
     * execution, so every position fact is constant for the length of one and a
     * moving bar sees what its first execution saw.
     */
    deliver(frame) {
        this.ledger.deliver(frame);
    }
    /** The strategy's own ledger, `stdlib.md` 17.7, oldest row first. */
    orders() {
        return this.ledger.rows();
    }
    execute(bar, state, isNew) {
        if (this.failure !== undefined) {
            return {
                index: this.index,
                columns: [],
                applied: false,
                effects: [],
                frames: [],
                alerts: [],
                diagnostic: this.failure,
            };
        }
        const index = this.index;
        // The fold, at the boundary between two bars and before step 4. A
        // re-execution folds nothing: the same frames reaching one bar twice would
        // settle the same fill twice.
        const frames = isNew ? this.ledger.settle() : [];
        // The bar before this one, which is what says whether this bar opened a
        // session or is inside the one that bar was already in. Read from the bars
        // themselves rather than carried, so a re-executed bar compares against the
        // same neighbour it compared against the first time.
        const previous = this.known.at(index - 1)?.time ?? null;
        this.facts = factsFor(index, this.supplied, state, isNew, this.updates, this.sessions.factsAt(bar.time ?? null, previous));
        this.view = barViewOf(bar, this.facts, this.previousClose);
        try {
            // Step 2. Any entry a previous execution of this bar wrote is discarded.
            this.registers.truncate(index);
            // Step 3.
            this.channels.clear();
            this.registers.clearCurrent();
            this.budget.begin(index);
            this.grids.clear();
            this.machine.begin(this.view, index);
            // Step 4.
            const slots = this.machine.slots();
            for (const register of this.program.series) {
                if (register.kind !== 'bar' || register.field === null)
                    continue;
                this.registers.set(register.id, barField(register.field, bar, this.facts));
            }
            // The same step fills each read's `"request"` register, absent where the
            // answer has not arrived or the read's mode allows no value yet (2.16).
            if (!this.requests.empty)
                this.requests.fill(this.registers, this.known, index, isNew);
            // Step 5. An input's value and a grid's handle land in their slots here,
            // and nothing is resolved: that happened once, at load.
            for (const input of this.inputs) {
                slots[input.slot] = storedValue(input.field === undefined ? input.value : barField(input.field, bar, this.facts));
            }
            this.grids.fill(slots);
            // Step 6.
            this.machine.run();
        }
        catch (thrown) {
            return this.stopped(thrown);
        }
        // Step 7.
        this.registers.close(index);
        // Step 8: the columns, whatever the bar's state.
        this.channels.publish(index);
        // Step 9. The deferred channels and the pending effects, together: a
        // marker, an alert and an order are one decision about one bar, and an
        // order the language will not place stops the bar with nothing routed.
        const applied = this.facts.isConfirmed || this.onUnconfirmed;
        const pending = this.channels.decide(index, applied);
        const sending = { index, time: bar.time ?? null };
        const routed = routedEffects(this.ledger, pending, sending, this.options.host?.route);
        if (routed.refusal !== undefined)
            return this.stopped(new ScriptError(routed.refusal));
        const alerts = applied
            ? this.alerting.raise({ index, time: bar.time ?? null, isRealtime: this.facts.isRealtime }, (channel) => this.channels.at(channel, index))
            : [];
        // Step 10.
        this.registers.trim(index, this.program.limits.history);
        this.lastClose = bar.close ?? null;
        return {
            index,
            columns: this.channels.row(index),
            applied,
            effects: routed.effects,
            frames,
            alerts,
            diagnostic: undefined,
        };
    }
    /**
     * A hand-over the engine refuses, before any of it has been executed.
     *
     * Nothing is rolled back because nothing has run: the bar was never begun,
     * the previous bar's checkpoint still stands, and the columns already
     * published stay as they are. The script is stopped for the same reason a
     * failed bar stops it, which is that the next bar would be computed on a
     * state nobody can account for.
     */
    refuse(diagnostic) {
        this.failure = diagnostic;
        return {
            index: this.index,
            columns: [],
            applied: false,
            effects: [],
            frames: [],
            alerts: [],
            diagnostic,
        };
    }
    /** A bar that failed: steps 7 to 11 do not run, the journal rolls back, the script stops. */
    stopped(thrown) {
        const diagnostic = thrown instanceof ScriptError ? thrown.diagnostic : unexpected('the bar', thrown);
        this.rollback();
        this.failure = diagnostic;
        return {
            index: this.index,
            columns: [],
            applied: false,
            effects: [],
            frames: [],
            alerts: [],
            diagnostic,
        };
    }
    /** Step 11, and the sweep that pays for the objects the bar left behind. */
    checkpoint() {
        this.memory.commit();
        this.heap.commit();
        this.heap.sweep((visit) => {
            this.memory.walk(visit);
            this.registers.walk(visit);
            this.grids.walk(visit);
        });
    }
    rollback() {
        this.memory.rollback();
        this.heap.rollback();
    }
    /** One channel's column over every bar executed so far. */
    column(channel) {
        return this.channels.column(channel, this.supplied);
    }
    /** The drawing objects a host should render, in creation order. */
    drawings() {
        return drawingsIn(this.heap);
    }
    /** The grids and the cells the last executed bar wrote into them. */
    tables() {
        return this.grids.read();
    }
}
//# sourceMappingURL=engine.js.map