import { ABSENT, storedValue } from './values/index.js';
export class Registers {
    histories;
    current;
    /** The bar index that sits at position 0 of every history. */
    base = 0;
    constructor(count) {
        this.histories = [];
        for (let i = 0; i < count; i += 1)
            this.histories.push([]);
        this.current = new Array(count).fill(ABSENT);
    }
    count() {
        return this.current.length;
    }
    /** Step 2: discard any entry a previous execution of bar `bar` wrote. */
    truncate(bar) {
        const keep = Math.max(bar - this.base, 0);
        for (const history of this.histories) {
            if (history.length > keep)
                history.length = keep;
        }
    }
    /** Step 3: every register's current bar cell starts absent. */
    clearCurrent() {
        this.current.fill(ABSENT);
    }
    set(register, value) {
        this.current[register] = storedValue(value);
    }
    /** `SLOAD`: the register's value for the bar being executed. */
    get(register) {
        return this.current[register] ?? ABSENT;
    }
    /** Step 7: the current bar cell becomes this bar's history entry. */
    close(bar) {
        const at = bar - this.base;
        for (let r = 0; r < this.histories.length; r += 1) {
            const history = this.histories[r];
            if (history === undefined)
                continue;
            history[at] = this.current[r] ?? ABSENT;
        }
    }
    /**
     * The value a register held `back` bars before `bar`.
     *
     * Offset 0 is the bar being executed and reads the current cell, which is why
     * `close` has not run yet when a script reads `x[0]`.
     */
    at(register, bar, back) {
        if (back === 0)
            return this.current[register] ?? ABSENT;
        const history = this.histories[register];
        if (history === undefined)
            return ABSENT;
        const at = bar - back - this.base;
        if (at < 0 || at >= history.length)
            return ABSENT;
        return history[at] ?? ABSENT;
    }
    /** Step 10: drop entries older than the retained depth. */
    trim(bar, depth) {
        if (depth === null)
            return;
        const wanted = bar + 1 - depth;
        const drop = wanted - this.base;
        // One pass only when the stale entries have paid for it, so a long run
        // stays linear rather than splicing every register on every bar.
        if (drop < depth || drop <= 0)
            return;
        for (const history of this.histories)
            history.splice(0, drop);
        this.base += drop;
    }
    /** Every value a register holds, for the heap's reachability walk. */
    walk(visit) {
        for (const history of this.histories)
            for (const value of history)
                visit(value);
        for (const value of this.current)
            visit(value);
    }
}
//# sourceMappingURL=registers.js.map