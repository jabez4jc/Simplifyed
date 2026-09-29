import { minutesOf, nominalMinutes, parseTimeframe } from '../../core/engine/index.js';
import { hostBar } from './bars.js';
/** The store key. Namespaced, because the store belongs to the host as well. */
const STATION = 'openscript:requests';
const MINUTE = 60;
export class Station {
    entries = new Map();
    /** What the last calculation asked about, keyed the same way. */
    wanted = new Map();
    transport;
    closed = false;
    unsubscribe;
    /**
     * The provider the engine is loaded with, bound to the bars on screen.
     *
     * Asking for one is the start of a round: the engine is about to ask about
     * every read this program makes, so what was wanted before this moment is
     * what the previous program wanted. A setting that names a different
     * instrument would otherwise leave the old one being fetched for as long as
     * the study lives, and reported on.
     */
    provider(bars) {
        this.wanted.clear();
        return (query) => {
            // A read of the chart's own instrument at a coarser interval is folded
            // from the bars the engine already holds, which is the read
            // `host-interface.md` 5.1 says it can satisfy without a host.
            if (query.read === 'timeframe')
                return undefined;
            const need = needFor(query, bars);
            if (need === undefined)
                return undefined;
            const key = keyOf(need);
            this.wanted.set(key, widest(this.wanted.get(key), need));
            return answerOf(this.entries.get(key));
        };
    }
    /**
     * The range each read needs, against the bars as they now stand.
     *
     * A calculation that reused the held engine never asked the provider
     * anything, so nothing would notice that the newest chart bar has moved into
     * the next requested bucket. This is what notices: it widens what is wanted,
     * and the fetch that follows asks for the recompute that reads it. An answer
     * is never spliced into a run that is already past the bars it would have
     * changed, which is `host-interface.md` 5.3.
     */
    extend(bars) {
        const last = bars[bars.length - 1];
        if (last === undefined)
            return;
        for (const [key, need] of this.wanted) {
            const timeframe = parseTimeframe(need.interval);
            if (timeframe === undefined)
                continue;
            const span = (minutesOf(timeframe) ?? nominalMinutes(timeframe)) * MINUTE;
            const to = Math.ceil((last.time + 1) / span) * span;
            if (to > need.to)
                this.wanted.set(key, { ...need, to });
        }
    }
    /**
     * After a calculation: start what is missing and say where the study stands.
     *
     * It is the end of the calculation rather than the middle of it because a
     * fetch that resolves asks for a recompute, and asking for one from inside the
     * calculation it would replace is a loop waiting to be written.
     */
    settle() {
        this.pump();
        const transport = this.transport;
        if (transport === undefined)
            return;
        transport.status(this.status());
        transport.retry(this.failed() ? () => this.again() : null);
    }
    /** The lifecycle, with the transport the first calculation did not have. */
    open(ctx) {
        const ask = ctx.requestBars;
        if (ask === undefined)
            return;
        this.closed = false;
        this.transport = {
            request: (need) => ask({
                symbol: need.symbol,
                ...(need.exchange === undefined ? {} : { exchange: need.exchange }),
                interval: need.interval,
                from: need.from,
                to: need.to,
            }),
            recompute: () => ctx.requestRecompute(),
            status: (status) => ctx.setDataStatus?.(status),
            retry: (retry) => ctx.setDataRetry?.(retry),
        };
        // An identity change makes every key a different one, so the entries under
        // the old identity would sit there for as long as the instance does.
        this.unsubscribe = ctx.subscribeDataChanges?.((change) => {
            if (change === 'context')
                this.entries.clear();
        });
        this.settle();
    }
    /**
     * The lifecycle is over: nothing in flight may write anything again.
     *
     * What was fetched is kept. A chart runs the lifecycle again after a settings
     * change, and throwing the bars away there would put a network round trip
     * behind moving a slider. A fetch that was in flight is marked as not in
     * flight, so a station that is opened again starts it rather than waiting for
     * an answer whose callback has been told to do nothing.
     */
    close() {
        this.closed = true;
        this.transport = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const entry of this.entries.values())
            entry.fetching = false;
    }
    /** Every read the host refused, tried again from the beginning. */
    again() {
        for (const [key, entry] of this.entries) {
            if (entry.reason !== undefined || entry.empty)
                this.entries.delete(key);
        }
        this.pump();
        this.transport?.recompute();
    }
    pump() {
        const transport = this.transport;
        if (transport === undefined || this.closed)
            return;
        for (const [key, need] of this.wanted) {
            const entry = this.entries.get(key);
            if (entry !== undefined && entry.fetching)
                continue;
            if (entry !== undefined && entry.reason !== undefined)
                continue;
            if (entry !== undefined && need.from >= entry.from && need.to <= entry.to)
                continue;
            this.fetch(key, need, entry, transport);
        }
    }
    fetch(key, need, held, transport) {
        const entry = {
            from: need.from,
            to: need.to,
            fetching: true,
            bars: held?.bars,
            reason: undefined,
            empty: false,
        };
        this.entries.set(key, entry);
        transport.request(need).then((bars) => {
            this.landed(key, entry, bars);
        }, (error) => {
            this.refused(key, entry, error);
        });
    }
    /** An answer, once the transport has one. */
    landed(key, entry, bars) {
        if (this.closed || this.entries.get(key) !== entry)
            return;
        entry.fetching = false;
        entry.empty = bars.length === 0;
        if (bars.length > 0)
            entry.bars = bars.map(hostBar);
        this.transport?.recompute();
    }
    refused(key, entry, error) {
        if (this.closed || this.entries.get(key) !== entry)
            return;
        entry.fetching = false;
        entry.reason = reasonOf(error);
        this.transport?.recompute();
    }
    failed() {
        for (const entry of this.entries.values()) {
            if (entry.reason !== undefined || entry.empty)
                return true;
        }
        return false;
    }
    /** Where the study's own data stands, in the four words the chart has. */
    status() {
        let waiting = false;
        let empty = false;
        for (const key of this.wanted.keys()) {
            const entry = this.entries.get(key);
            if (entry === undefined || entry.fetching)
                waiting = true;
            if (entry?.reason !== undefined)
                return { state: 'error', error: new Error(entry.reason) };
            if (entry?.empty === true)
                empty = true;
        }
        if (waiting)
            return { state: 'loading' };
        if (empty)
            return { state: 'empty' };
        return { state: 'ready' };
    }
}
/** The station this instance holds, created by whichever half arrives first. */
export function stationIn(store) {
    const held = store[STATION];
    if (held instanceof Station)
        return held;
    const made = new Station();
    store[STATION] = made;
    return made;
}
/** The station this instance holds, when it has one. */
export function stationOf(store) {
    const held = store[STATION];
    return held instanceof Station ? held : undefined;
}
function keyOf(need) {
    return `${need.symbol}|${need.exchange ?? ''}|${need.interval}`;
}
/** Two needs for one series: the wider range, so one fetch serves both. */
function widest(held, need) {
    if (held === undefined)
        return need;
    return {
        ...need,
        from: Math.min(held.from, need.from),
        to: Math.max(held.to, need.to),
    };
}
function answerOf(entry) {
    if (entry === undefined)
        return { pending: true };
    if (entry.reason !== undefined) {
        return { refused: { code: 'OS6009', reason: entry.reason } };
    }
    if (entry.bars !== undefined)
        return { bars: entry.bars };
    if (entry.empty)
        return { refused: { code: 'OS6008' } };
    return { pending: true };
}
/**
 * The range one read is fetched over, quantised to requested bar boundaries.
 *
 * The nominal length of a requested bar is what the arithmetic uses, a month
 * included. It decides how far back and how far forward to ask, not where a
 * bucket begins, which is the calendar's and the engine's; asking for a few
 * hours too many is a floor being generous and asking for exactly the right
 * calendar month would need the instrument's zone to be stated here as well.
 */
function needFor(query, bars) {
    const symbol = query.instrument;
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (symbol === null || first === undefined || last === undefined)
        return undefined;
    const timeframe = parseTimeframe(query.timeframe);
    if (timeframe === undefined)
        return undefined;
    const span = (minutesOf(timeframe) ?? nominalMinutes(timeframe)) * MINUTE;
    const warmup = query.warmup ?? 0;
    return {
        symbol,
        exchange: query.exchange ?? undefined,
        interval: query.timeframe,
        from: Math.floor((first.time - warmup * span) / span) * span,
        to: Math.ceil((last.time + 1) / span) * span,
    };
}
/** The host's own words, carried and never paraphrased. */
function reasonOf(error) {
    if (error instanceof Error && error.message !== '')
        return error.message;
    return typeof error === 'string' && error !== '' ? error : 'the host gave no reason';
}
//# sourceMappingURL=requests.js.map