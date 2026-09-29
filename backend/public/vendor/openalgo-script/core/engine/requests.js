import { sourceOf } from './bar-source.js';
import { RequestBody, bodyProgram } from './request-body.js';
import { askHost, reasonFor, undatable, undatableReason } from './request-plan.js';
import { bucketKeyOf } from './timeframe.js';
import { ABSENT } from './values/index.js';
const START = { cursor: 0, openKey: undefined, openFrom: 0 };
export class RequestSet {
    reads = [];
    byId = new Map();
    parts;
    constructor(parts, requests) {
        this.parts = parts;
        for (const request of requests) {
            const plan = parts.plans.get(request.id);
            if (plan === undefined)
                continue;
            const read = build(parts, request, plan);
            this.reads.push(read);
            this.byId.set(request.id, read);
        }
    }
    get empty() {
        return this.reads.length === 0;
    }
    /**
     * Step 4: each read's value for this bar, written into its `"request"`
     * register.
     *
     * `fresh` says whether this is the first execution of this bar. A bar that is
     * executing again restores the fold to where it stood when the bar began and
     * rebuilds the bucket now forming from the source as it now stands, which is
     * what makes a moving bar idempotent one level down: the newest chart bar may
     * have been revised since the last execution, and the bucket it is inside has
     * to be rebuilt from the revision rather than from the reading it replaced.
     */
    fill(registers, bars, index, fresh) {
        const heap = this.parts.heapOf();
        for (const read of this.reads) {
            if (fresh) {
                read.mark = { cursor: read.cursor, openKey: read.openKey, openFrom: read.openFrom };
            }
            else {
                restore(read, bars);
            }
            // The body's value is the body's, in the body's heap. `carry` is what
            // makes it a value of the machine that is about to read it.
            registers.set(read.register, read.body.carry(valueOf(read, bars, index), heap));
        }
    }
    /** `req.isReady(read)`: whether the host has answered this one yet. */
    answered(id) {
        return typeof id === 'number' ? this.byId.get(id)?.ready === true : false;
    }
    /** `req.error(read)`: the reason it failed, or the empty string when none has. */
    failure(id) {
        return typeof id === 'number' ? this.byId.get(id)?.reason ?? '' : '';
    }
}
function build(parts, request, plan) {
    const view = bodyProgram(parts.program, request);
    const answer = askHost(plan, parts.host);
    const refused = answer !== undefined && 'refused' in answer ? answer.refused : undefined;
    let body;
    // The facts a body reads are the chart's, except the three that identify an
    // instrument: inside a read, those are the instrument and the interval the
    // read asked for. The two request calls answer about the reads written inside
    // this body, which is why the set below is built before the body is.
    let nested;
    const facts = {
        ...parts.facts,
        symbol: () => plan.query.instrument ?? parts.facts.symbol(),
        exchange: () => plan.query.exchange ?? parts.facts.exchange(),
        interval: () => plan.query.timeframe,
        requestReady: (id) => nested?.answered(id) ?? false,
        requestError: (id) => nested?.failure(id) ?? '',
    };
    nested = new RequestSet(
    // A read inside this one lands in this body's heap, which is built below.
    { ...parts, program: view, facts, heapOf: () => body.objects }, request.body.requests);
    body = new RequestBody({
        program: view,
        limits: parts.limits,
        clock: parts.clock,
        host: facts,
        position: parts.position,
        library: parts.library,
        inputs: request.body.inputs.map((one) => ({
            series: one.series,
            value: parts.inputs.find((input) => input.key === one.input)?.value ?? null,
        })),
        nested,
        spanAt: parts.spanAt,
    });
    // A reason is the read saying why it will never answer. A refusal is the
    // host's; a calendar fold with no zone to date a bucket in is the engine's,
    // and it is stated here rather than left as an absence the study cannot
    // explain. The host's own words win where both hold: a source that refused is
    // the fix the user can act on first.
    const reason = refused !== undefined
        ? reasonFor(refused, plan.query)
        : undatable(plan)
            ? undatableReason(plan.query)
            : '';
    return {
        plan,
        register: request.series,
        body,
        source: answer !== undefined && 'bars' in answer ? sourceOf(answer.bars) : undefined,
        // A fold of the chart's own bars needs nothing from the host, so it is
        // answered the moment it is planned. A read the host is still fetching is
        // not: the read is absent, `req.isReady` is false, and the study keeps
        // drawing everything that does not depend on it. A read with a reason is
        // never ready: it is not waiting for anything.
        ready: reason === '' && (answer === undefined ? plan.query.read === 'timeframe' : 'bars' in answer),
        reason,
        cursor: 0,
        openKey: undefined,
        openFrom: 0,
        open: undefined,
        closedValue: ABSENT,
        highestClosed: undefined,
        mark: START,
    };
}
/** The read's value for the chart bar at `index`, and the fold that gets there. */
function valueOf(read, bars, index) {
    if (!read.ready)
        return ABSENT;
    const bar = bars.at(index);
    const at = bar?.time ?? null;
    if (at === null)
        return ABSENT;
    const key = keyOf(read, at);
    if (key === undefined)
        return ABSENT;
    const source = read.source ?? bars;
    const lookahead = read.plan.request.mode === 'lookahead';
    for (;;) {
        const next = source.at(read.cursor);
        if (next === undefined)
            break;
        const found = next.time === null ? undefined : keyOf(read, next.time);
        if (found === undefined) {
            // A source bar with no time, or none this calendar can date, belongs to
            // no bucket. It is stepped over rather than folded into whichever bucket
            // happens to be open.
            read.cursor += 1;
            continue;
        }
        // The one line the three modes differ in. A lookahead read may read to the
        // end of the bucket the chart bar is inside; the other two stop at the bar.
        if (lookahead ? found > key : (next.time ?? 0) > at)
            break;
        read.cursor += 1;
        feed(read, next, found);
    }
    if (read.plan.request.mode === 'confirmed')
        return read.closedValue;
    if (read.openKey !== key || read.open === undefined)
        return ABSENT;
    return read.body.peek(read.open);
}
function keyOf(read, instant) {
    return bucketKeyOf(instant, read.plan.timeframe, read.plan.zone);
}
/**
 * One source bar folded in.
 *
 * A bar whose key is the open bucket's extends it. A bar whose key is new
 * closes the open bucket, which is the only place a requested bar ever settles:
 * a bucket is closed by something later, never by the clock. The guard on
 * `highestClosed` is what makes that idempotent, because a chart bar that
 * closed a bucket on its first execution must not close it again on its second.
 */
function feed(read, bar, key) {
    if (read.openKey === key && read.open !== undefined) {
        read.open = extend(read.open, bar);
        return;
    }
    if (read.openKey !== undefined && read.open !== undefined) {
        if (read.highestClosed === undefined || read.openKey > read.highestClosed) {
            read.closedValue = read.body.settle(read.open);
            read.highestClosed = read.openKey;
        }
    }
    read.openKey = key;
    read.openFrom = read.cursor - 1;
    read.open = start(bar);
}
/** A re-executed bar: the fold as it stood when the bar began. */
function restore(read, bars) {
    read.cursor = read.mark.cursor;
    read.openKey = read.mark.openKey;
    read.openFrom = read.mark.openFrom;
    read.open = undefined;
    if (read.openKey === undefined)
        return;
    const source = read.source ?? bars;
    for (let at = read.openFrom; at < read.cursor; at += 1) {
        const bar = source.at(at);
        if (bar === undefined || bar.time === null)
            continue;
        if (keyOf(read, bar.time) !== read.openKey)
            continue;
        read.open = read.open === undefined ? start(bar) : extend(read.open, bar);
    }
}
/**
 * The first source bar of a bucket, as a bar of its own.
 *
 * The bucket's `time` is this bar's open instant rather than the instant the
 * bucket's key names. The two differ whenever trading begins after the boundary,
 * which is every session on a daily fold, and the first bar's instant is a
 * reading from the data while the boundary is a number the engine chose.
 */
function start(bar) {
    return {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ?? null,
        time: bar.time,
        oi: bar.oi ?? null,
    };
}
/**
 * One more source bar in the same bucket.
 *
 * **Absence propagates through every field**, which is `host-interface.md` 3.1:
 * an absent price is a hole and what it feeds turns absent. So a bucket whose
 * high is missing from one of its bars has no high, rather than the highest of
 * the bars that did report one, which would be a number with no name. Open is
 * the first bar's, close is the last bar's, and open interest is a level rather
 * than a flow so the coarser bar takes the last and never the sum.
 */
function extend(into, bar) {
    return {
        open: into.open,
        high: higher(into.high, bar.high),
        low: lower(into.low, bar.low),
        close: bar.close ?? null,
        volume: both(into.volume ?? null, bar.volume ?? null),
        time: into.time,
        oi: bar.oi ?? null,
    };
}
function higher(a, b) {
    if (a === null || typeof b !== 'number')
        return null;
    return b > a ? b : a;
}
function lower(a, b) {
    if (a === null || typeof b !== 'number')
        return null;
    return b < a ? b : a;
}
function both(a, b) {
    return a === null || b === null ? null : a + b;
}
//# sourceMappingURL=requests.js.map