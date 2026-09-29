/**
 * The loop: a compiled program, some bars, and the record of what happened.
 *
 * **Everything is collected as it arrives.** Each bar hands back what it
 * applied and what the frames delivered before it did to the ledger, and that
 * is what the record is built from. Nothing is read back at the end except one
 * snapshot of the ledger, and that snapshot is copied rather than kept:
 * `engine.orders()` hands back the ledger's own array, which the fold writes
 * into and a refused bar truncates, so a driver holding on to it would report
 * whatever the array happened to say last rather than what the run did.
 *
 * **Every bar supplied executes and only the ones inside the window are
 * reported.** A bar before the window is warmup: it runs, its orders are real,
 * and a position opened on it is carried in. What it does not get is an equity
 * point. `range.ts` decides which is which and refuses a window holding no bar
 * at all, before the first bar rather than after the last.
 *
 * **The bar count handed over is the total.** An engine told that each bar is
 * the only bar reports `bar.isLast` true on every one of them, and a strategy
 * that flattens on the last bar then flattens on all of them.
 *
 * **Frames are delivered at the boundary and folded there.** What the venue
 * answered after bar k reaches the engine before bar k + 1 executes, which is
 * where `host-interface.md` 7.4 puts the intake, and the outcome of that fold
 * is reported on bar k + 1. A frame answered after the last bar has no boundary
 * left to fold at: it is not delivered, it is not recorded as delivered, and
 * the order it was about is in the ledger at whatever it last said.
 *
 * **Two drivers, and the only difference between them is where the frames come
 * from.** `backtest` runs against the simulated destination, which decides a
 * fill from the bars and answers frames of its own; `backtestSupplied` is
 * handed the frames and delivers those. Everything else about the two is one
 * function below: the same window, the same load, the same refusals, the same
 * loop and the same record.
 */
import { reportOf, scheduleFromDeclaration } from '../accounting/index.js';
import { load } from '../engine/index.js';
import { declarationOf } from './declaration.js';
import { Delivery, framedAs, ordinalsOf } from './deliver.js';
import { marksFor, windowFor } from './range.js';
import { orderIn, recordOf } from './record.js';
import { Simulator } from './simulate.js';
import { checkSettings } from './settings.js';
import { walk } from './walk.js';
/**
 * One run against a simulated destination, from a compiled program to a record.
 *
 * The frames are the destination's own: it is handed the orders, it reads the
 * bars, and what it answers is what the engine folds. A run whose frames
 * somebody else is supplying is `backtestSupplied` below.
 */
export function backtest(program, bars, settings, options = {}) {
    return drive(program, bars, settings, options, (declared, schedule) => simulated(new Simulator({
        bars,
        contract: settings.contract,
        fill: settings.fill,
        slippageTicks: schedule.slippageTicks,
        fillOn: declared.fillOn,
        qtyType: declared.qtyType,
    })));
}
/**
 * One run over the frames somebody else supplied, which this engine does not
 * choose and does not add to.
 *
 * `conformance.md` section 3 gives a case a `frames.csv` that supplies order
 * frames the way `bars.csv` supplies bars, so that a case asserts the fold
 * against input the engine did not choose. Every other argument is `backtest`'s
 * and means there what it means here. A row is delivered at the boundary it
 * names and folded before the next bar, and the record carries the rows it was
 * handed rather than a second spelling of them.
 *
 * **Nothing is invented.** No fill is priced off a bar, no order rests and no
 * schedule is read, so an order the frames say nothing about stays where its
 * placement left it, which is what a case saying nothing about it means.
 *
 * **A record made here is a record of this run and not of a simulated one.**
 * `rerun` puts a record's program back on a simulated destination, because a
 * record does not say which of the two answered it, so a rerun of one of these
 * reproduces it only where that destination would answer these same frames.
 */
export function backtestSupplied(program, bars, settings, frames, options = {}) {
    return drive(program, bars, settings, options, () => new Delivery(frames));
}
/**
 * The run both drivers are, and the one place a record is made.
 *
 * A refusal before the first bar comes back as a refusal and not as a record:
 * a program that would not load, a setting that cannot be applied and a window
 * holding no bars are all runs that did not happen, and a record of one would
 * be a document asserting figures nothing computed. A failure during a bar is
 * the other way round: the run happened, it stopped, and the record carries
 * both what it did and the diagnostic that stopped it.
 *
 * **The destination is chosen after the program is loaded**, which is why it
 * arrives as a function of the declaration and the schedule: the bar a market
 * order is priced at is the declaration's, and the declaration is resolved at
 * load. The route is wired first and reaches whatever is chosen through the
 * binding below, which is what lets one host serve both halves.
 */
function drive(program, bars, settings, options, choose) {
    const framed = windowFor(bars, settings.range);
    if (!framed.ok)
        return { ok: false, diagnostic: framed.diagnostic };
    let sending;
    const instrument = instrumentFor(settings.contract, options.instrument ?? {});
    const loaded = load(program, {
        settings: settings.inputs,
        host: hostFor(instrument, settings.now, (effect, bar) => sending?.route(effect, bar), options.requestBars),
    });
    if (!loaded.ok)
        return { ok: false, diagnostic: loaded.diagnostic };
    const engine = loaded.engine;
    const declared = declarationOf(engine.program, loaded.inputs);
    const problem = checkSettings(settings, declared);
    if (problem !== null)
        return { ok: false, diagnostic: problem };
    const schedule = scheduleFor(settings, declared);
    const destination = choose(declared, schedule);
    sending = destination;
    const run = walk(engine, destination, bars, framed.covered, options);
    const ordinals = ordinalsOf(destination.intents);
    const marks = marksFor(bars, framed.covered);
    return {
        ok: true,
        ...(options.rows === true ? { rows: run.rows } : {}),
        ...(options.log === true ? { log: run.log } : {}),
        ...(options.surface === true ? { surface: { drawings: engine.drawings(), tables: engine.tables() } } : {}),
        record: recordOf({
            program: engine.program,
            ...(options.sourceText === undefined ? {} : { sourceText: options.sourceText }),
            settings,
            instrument,
            bars,
            form: options.form ?? 'inline',
            // The row where a case supplied one, because that row is the input and a
            // record of a run over it says what it was given rather than what it
            // would have written down had it decided the frame itself.
            frames: run.frames.map((one) => one.row ?? framedAs(one.frame, one.afterBar, ordinals)),
            fills: run.fills,
            orders: ordersOf(engine.orders(), destination.intents, ordinals),
            diagnostics: run.diagnostics,
            report: reportOf(run.fills, marks, schedule, settings.contract, declared.capital),
        }),
    };
}
/** The simulated destination, as a destination the loop below can drive. */
function simulated(venue) {
    return {
        route: (effect, barIndex) => venue.route(effect, barIndex),
        answers: (barIndex) => venue.framesFor(barIndex).map((frame) => ({ frame, afterBar: barIndex, row: null })),
        intents: venue.intents,
    };
}
/** The ledger at the end, copied out of the engine's own array. */
function ordersOf(rows, intents, ordinals) {
    return rows.map((row) => {
        const intent = intents.find((one) => one.intentId === row.intentId);
        return orderIn(row, ordinals.get(row.intentId) ?? 0, intent?.qtyType ?? '');
    });
}
/**
 * The cost model the run is carried out under.
 *
 * The host's schedule where it supplied one, and otherwise the declaration's
 * own commission as the one kind of schedule the money layer evaluates. Both
 * cannot be stated at once: that is OS6023 and it is refused before this is
 * asked.
 */
function scheduleFor(settings, declared) {
    if (settings.costs !== null)
        return settings.costs;
    return scheduleFromDeclaration(declared.commission, declared.commissionType, declared.slippage, settings.contract.currency, settings.contract.digits);
}
/**
 * The instrument record of `host-interface.md` 4.1 the engine is handed, and
 * the record carries verbatim.
 *
 * Composed once, here, from the contract's six facts and the six stated beside
 * it, so the engine and the record read one document and there is no second
 * composition for the two to disagree by. A fact nobody stated is left out
 * rather than written as undefined: the record travels as JSON, which drops an
 * undefined member, and a document that changes shape in transit is not the
 * document the engine read.
 */
function instrumentFor(contract, facts) {
    return {
        ...(contract.symbol === null ? {} : { symbol: contract.symbol }),
        ...(contract.exchange === null ? {} : { exchange: contract.exchange }),
        ...(facts.interval === undefined ? {} : { interval: facts.interval }),
        ...(facts.timezone === undefined ? {} : { timezone: facts.timezone }),
        ...(contract.tickSize === null ? {} : { tickSize: contract.tickSize }),
        ...(contract.lotSize === null ? {} : { lotSize: contract.lotSize }),
        pointValue: contract.pointValue,
        currency: contract.currency,
        ...(facts.instrumentType === undefined ? {} : { instrumentType: facts.instrumentType }),
        ...(facts.hasVolume === undefined ? {} : { hasVolume: facts.hasVolume }),
        ...(facts.hasOpenInterest === undefined ? {} : { hasOpenInterest: facts.hasOpenInterest }),
        ...(facts.session === undefined ? {} : { session: facts.session }),
    };
}
/**
 * The host a backtest is: an instrument record, a clock and a destination.
 *
 * Duty 3 is served only when the caller supplied bars for it. A backtest with
 * none holds the chart's own bars and nothing else, so a program that reads
 * another instrument declares a capability this host does not have and is
 * refused at load, by name, rather than drawing a line with nothing in it.
 */
function hostFor(instrument, now, route, requestBars) {
    return {
        instrument,
        ...(now === null ? {} : { now }),
        route,
        ...(requestBars === undefined ? {} : { requestBars }),
    };
}
//# sourceMappingURL=drive.js.map