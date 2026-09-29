import { ABSENT, storedValue } from './values/index.js';
export class Channels {
    current;
    deferred;
    /** One column per channel: the value published for each bar. */
    columns;
    /** Whether step 9 applied the deferred channels for each bar. */
    decided = [];
    pending = [];
    /** Whether any channel at all is deferred, so the common case costs nothing. */
    anyDeferred;
    constructor(channels) {
        this.current = new Array(channels.length).fill(ABSENT);
        this.deferred = channels.map((one) => one.defer);
        this.anyDeferred = this.deferred.some((one) => one);
        this.columns = channels.map(() => []);
    }
    count() {
        return this.current.length;
    }
    /** Step 3: every channel and the pending effect list start empty. */
    clear() {
        this.current.fill(ABSENT);
        this.pending = [];
    }
    /** `EMIT`: the last write on a bar is the one that counts. */
    write(channel, value) {
        this.current[channel] = storedValue(value);
    }
    read(channel) {
        return this.current[channel] ?? ABSENT;
    }
    /** 5.4: a call with an effect records itself and pushes absent. */
    defer(record) {
        this.pending.push(record);
    }
    /** Step 8: the columns, absence included, whatever the bar's state. */
    publish(bar) {
        for (let c = 0; c < this.columns.length; c += 1) {
            const column = this.columns[c];
            if (column === undefined)
                continue;
            column[bar] = this.current[c] ?? ABSENT;
        }
    }
    /**
     * Step 9: the deferred channels and the effects, or neither.
     *
     * Returns the effects to apply, and nothing when the bar is still moving. The
     * consequence is the one `language.md` 7.5 promises: a condition that was
     * true halfway through a bar and false when it closed never places an order,
     * because the execution that produced the record was thrown away.
     */
    decide(bar, apply) {
        this.decided[bar] = apply;
        if (!apply) {
            this.pending = [];
            return [];
        }
        const effects = this.pending;
        this.pending = [];
        return effects;
    }
    /** Whether a channel's value is held back on a bar that is still moving. */
    isDeferred(channel) {
        return this.deferred[channel] === true;
    }
    /** The value published for one channel on one bar, absent where nothing wrote. */
    at(channel, bar) {
        if (this.withheld(channel, bar))
            return ABSENT;
        return this.columns[channel]?.[bar] ?? ABSENT;
    }
    /** One channel's whole column, for a host building a plotted series. */
    column(channel, bars) {
        const held = this.columns[channel] ?? [];
        const deferred = this.anyDeferred && this.deferred[channel] === true;
        const out = [];
        for (let bar = 0; bar < bars; bar += 1) {
            out.push(deferred && this.decided[bar] !== true ? ABSENT : held[bar] ?? ABSENT);
        }
        return out;
    }
    /** Every channel's value on one bar, which is what a bar's result carries. */
    row(bar) {
        return this.columns.map((column, channel) => this.withheld(channel, bar) ? ABSENT : column[bar] ?? ABSENT);
    }
    /**
     * Whether a channel's value for a bar is one step 9 discarded.
     *
     * A channel that is not deferred is never withheld, and a bar step 9 applied
     * withholds nothing, so this is false for every channel of every confirmed
     * bar and for every plot column ever.
     */
    withheld(channel, bar) {
        return this.anyDeferred && this.deferred[channel] === true && this.decided[bar] !== true;
    }
}
//# sourceMappingURL=channels.js.map