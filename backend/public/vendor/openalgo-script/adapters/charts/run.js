import { load, utcTime } from '../../core/engine/index.js';
import { hostBar, hostNow, stateFor } from './bars.js';
import { capabilitiesOf } from './capabilities.js';
import { refused, stopped } from './errors.js';
import { undrawable } from './undrawable.js';
import { stationIn, stationOf } from './requests.js';
import { engineSettings, signatureOf } from './settings.js';
import { answersFor, needsVenue, routeInto, venueFor } from './venue.js';
import { runWhole, walkWith } from './driving.js';
/** The engine one chart instance is holding, between recomputes. */
/** The store key. Namespaced, because the store belongs to the host as well. */
const HELD = 'openscript';
export function fullRun(program, bars, settings, store, ctx, options) {
    const station = stationIn(store);
    const started = start(program, settings, ctx, options, station.provider(bars), bars);
    const engine = started.engine;
    // **A strategy is walked bar by bar and a study is handed the lot.** The
    // difference is the venue: its frames reach the engine between bars, which is
    // the only place they can, so a strategy's position is right on the bar after
    // the one it traded on. `run()` has no gap to put them in.
    //
    // It is also the loop the backtest uses, which is the point: a chart drawing a
    // strategy and a report of the same strategy walk the same bars in the same
    // order against the same venue, so they cannot disagree about what filled.
    const held = started.venue === null
        ? runWhole(engine, bars, ctx, program, settings)
        : walkWith(engine, started.venue, bars, ctx, program, settings);
    store[HELD] = held;
    station.settle();
    return outputOf(program, engine);
}
/**
 * The bars from `from` onwards, or nothing when the held engine cannot serve
 * them.
 *
 * `from` is the previously last bar, which may have been replaced rather than
 * followed, so it is re-executed rather than appended: that is step 1 of the bar
 * cycle and the reason a moving bar draws the same study however many ticks it
 * took.
 */
export function tailRun(program, bars, from, settings, store, ctx, 
// Held for the shape of the pair: a full recompute reads the host's options
// and a tail run reads the engine it already built from them.
_options) {
    const held = store[HELD];
    if (held === undefined || held.engine.failed)
        return null;
    if (held.count !== from + 1 || from < 0 || bars.length < held.count)
        return null;
    if (held.signature !== signatureOf(program, settings))
        return null;
    if ((bars[0]?.time ?? 0) !== held.firstTime)
        return null;
    if ((bars[from]?.time ?? 0) !== held.lastTime)
        return null;
    for (let index = from; index < bars.length; index += 1) {
        const bar = bars[index];
        if (bar === undefined)
            return null;
        const state = stateFor(index, bars, ctx);
        // The venue's answers about the bar before this one, delivered before this
        // one runs, exactly as the full walk does. A tail that skipped this would
        // draw the first bars of a strategy correctly and then quietly stop folding
        // its fills the moment the chart went live, which is the half of the run
        // nobody re-checks.
        //
        // Only when the bar is new. Re-executing the bar that moved must not
        // deliver again: a frame is cumulative and folding one twice is harmless,
        // but the bar's own orders have been rolled back and answering them a
        // second time would fill an order the engine no longer knows it sent.
        if (held.venue !== null && index !== from) {
            for (const frame of held.venue.pending)
                held.engine.deliver(frame);
            held.venue.pending = [];
        }
        const result = index === from
            ? held.engine.update(hostBar(bar), state)
            : held.engine.append(hostBar(bar), state);
        if (result.diagnostic !== undefined)
            throw stopped(result.diagnostic);
        if (held.venue !== null)
            answersFor(held.venue, index);
    }
    held.count = bars.length;
    held.lastTime = bars[bars.length - 1]?.time ?? held.lastTime;
    // The provider was not asked anything this time, so the station is told where
    // the newest bar now stands rather than working it out from a question.
    const station = stationOf(store);
    station?.extend(bars);
    station?.settle();
    return outputOf(program, held.engine);
}
/**
 * A held engine is dropped when the descriptor's instance goes away.
 *
 * The station goes with it, because a fetch still in flight would otherwise ask
 * a chart that has removed this study to recompute it.
 */
export function release(store) {
    delete store[HELD];
    stationOf(store)?.close();
}
function outputOf(program, engine) {
    const columns = [];
    for (let channel = 0; channel < program.channels.length; channel += 1) {
        columns.push(engine.column(channel));
    }
    // The grids and the objects are read once, here. Reading either per bar would
    // cost the length of the history to display the last state of it, which is
    // `tables.ts`'s own first paragraph.
    return { columns, tables: engine.tables(), drawings: engine.drawings() };
}
/**
 * Load the program, and give a strategy somewhere for its orders to go.
 *
 * **The venue is built after the load and reached through a holder, because
 * neither can come first.** The route has to be handed to `load`, since that is
 * what declares the `orders` capability and a program needing one is otherwise
 * refused. The venue has to be built after it, because the declaration it reads
 * may state its fill rule through an `input()`, and inputs are not resolved
 * until `load` has run. The route is only ever called from inside an execution,
 * which is after both, so the holder is always filled by the time anything
 * reaches it.
 *
 * **A host that supplied its own route keeps it.** Somewhere real to send an
 * order is a better destination than a simulated one, and a host that wired one
 * up meant it.
 *
 * **And simulation is asked for rather than assumed.** Without
 * `simulateOrders` a strategy with nowhere to send an order is still refused at
 * load, which is the answer a host that meant to wire a destination and forgot
 * needs to see. Filling in a venue for them would turn that mistake into a
 * chart that draws convincingly and routes nothing, discovered whenever
 * somebody next looked for the orders.
 */
function start(program, settings, ctx, options, requests, bars) {
    const holder = { current: null };
    const simulate = options.simulateOrders === true && options.orders === undefined && needsVenue(program);
    const withRoute = simulate
        ? { ...options, orders: routeInto(holder) }
        : options;
    // What this chart has no room for is refused before the engine is asked,
    // because a study drawn without it is a study that looks broken.
    const narrower = undrawable(program, capabilitiesOf(options.chartVersion));
    if (narrower !== undefined)
        throw refused(narrower);
    const loaded = load(program, {
        settings: engineSettings(program, settings),
        host: hostFor(ctx, withRoute, requests),
        time: timeFor(options, ctx?.timezone ?? ''),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    if (!loaded.ok)
        throw refused(loaded.diagnostic);
    if (!simulate)
        return { engine: loaded.engine, venue: null };
    const venue = venueFor(program, bars, loaded.inputs, instrumentFor(ctx, options));
    if (venue === null)
        return { engine: loaded.engine, venue: null };
    holder.current = venue;
    return { engine: loaded.engine, venue: { venue, pending: [] } };
}
/**
 * The host the engine reads, which always serves requests.
 *
 * A chart offers the transport whether or not its own host registered a
 * provider, and it refuses with its own words when none was registered. So the
 * capability is declared here rather than withheld: a study that reads another
 * instrument then draws everything that does not depend on the read and puts
 * the chart's own sentence in `req.error`, instead of being refused at load
 * with OS6006 naming a capability the chart does have.
 */
/**
 * The instrument record, from what the host stated and what the chart knows.
 *
 * Its own function because two callers need it and they must not each build
 * one: the engine is loaded with this record, and the venue prices fills
 * against the tick size in it. Two spellings of the same record is how a fill
 * gets rounded to a tick the strategy was never told about.
 */
function instrumentFor(ctx, options) {
    return {
        ...(options.instrument ?? {}),
        ...(ctx?.symbol === undefined ? {} : { symbol: ctx.symbol }),
        ...(ctx?.interval === undefined ? {} : { interval: ctx.interval }),
        ...(ctx?.tickSize === undefined ? {} : { tickSize: ctx.tickSize }),
        // The chart states the zone it labels its own axis in, and every calendar
        // and session call reads in it. Leaving it out left the engine reading the
        // record's zone or nothing, so a session study could be an offset away from
        // the chart it was drawn on.
        ...(ctx === undefined || ctx.timezone === '' ? {} : { timezone: ctx.timezone }),
    };
}
function hostFor(ctx, options, requests) {
    const instrument = instrumentFor(ctx, options);
    return {
        instrument,
        requestBars: requests,
        ...(ctx === undefined ? {} : { now: hostNow(ctx.now()) }),
        ...(options.orders === undefined ? {} : { route: options.orders }),
    };
}
function timeFor(options, timezone) {
    const resolve = options.resolveTime;
    if (resolve === undefined)
        return utcTime;
    return (text) => {
        try {
            const seconds = resolve(text, timezone);
            return Number.isFinite(seconds) ? hostNow(seconds) : null;
        }
        catch {
            // A host's conversion refuses an unreadable string by throwing. That is a
            // value the input's own validation has to refuse, not a failure of the
            // chart, so it becomes absence and OS6019 names the key and the value.
            return null;
        }
    };
}
//# sourceMappingURL=run.js.map