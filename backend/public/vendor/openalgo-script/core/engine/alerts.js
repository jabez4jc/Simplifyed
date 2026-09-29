/**
 * The watched conditions, and the two rules that decide whether one fires.
 *
 * `outputs.alerts` is a declaration: a boolean channel, a message channel and a
 * frequency (`compiled-program.md` 2.8). Turning that into an alert somebody is
 * woken by is the engine's, because both rules that gate it are facts the
 * engine holds and a host asked to apply them would be applying them
 * differently in every host.
 *
 * **A confirmed bar, first.** The condition channel is declared `defer`, so it
 * is applied at step 9 and only on a bar the engine decided (5.4). A condition
 * that was true halfway through a bar and false when it closed never fires,
 * which is the whole of what makes an alert worth acting on.
 *
 * **A bar the host is driving live, second.** `stdlib.md` 16.2: adding a study
 * to a chart that already holds history fires nothing for those bars. The fact
 * that separates the two is `bar.isRealtime`, which the host states and no
 * engine can derive (`host-interface.md` 6.1 and 6.4): a history load states it
 * false for every bar, and a live feed states it true for the bar it is
 * driving. So the rule is one test against a fact somebody already had to
 * state, rather than a watermark this would have to keep and get wrong after a
 * recompute. An engine that only backtests states it false throughout and fires
 * nothing, which is the same answer from the other direction.
 *
 * Neither rule is rolled back. A moving bar re-executes and its deferred
 * channels are discarded each time, so nothing fires until the bar is decided;
 * once one has fired, it has been sent, and no rollback unsends it. That is why
 * `once` and `oncePerBar` are counted here rather than restored with the rest
 * of the state.
 */
import { fieldValue } from './inputs.js';
/** The three of `stdlib.md` 16.2, with the default first. */
const ONCE_PER_BAR = 'oncePerBar';
const ONCE = 'once';
/**
 * The watch for one program, with its declaration fields resolved.
 *
 * A title and a frequency are declaration fields, which a script may write with
 * an `input()`, and inputs are resolved once at load. So they are read here,
 * before bar 0, rather than per bar, as every other declaration the descriptor
 * is built from is.
 *
 * A field that holds no string at all is a program whose field was lost or hand
 * edited, and the frequency it falls back to is the safest of the three: at most
 * one alert for a bar.
 */
export function alertsFor(program, inputs) {
    const text = (field, fallback) => {
        const value = fieldValue(field, inputs);
        return typeof value === 'string' ? value : fallback;
    };
    return new Alerts(program.outputs.alerts, program.outputs.alerts.map((one) => ({
        title: text(one.title, ''),
        frequency: text(one.frequency, ONCE_PER_BAR),
    })));
}
export class Alerts {
    declared;
    resolved;
    /** The last bar each entry fired on, by declaration order. */
    lastBar;
    everFired;
    constructor(declared, resolved) {
        this.declared = declared;
        this.resolved = resolved;
        this.lastBar = declared.map(() => -1);
        this.everFired = declared.map(() => false);
    }
    /**
     * Step 9 on a bar the engine decided: the alerts it raises, in order.
     *
     * `read` is the channel's published value for this bar. A condition that is
     * absent is not true, which is `language.md` 6.6's three-valued logic reaching
     * a surface: an alert under a guard that was absent during warmup does not
     * fire, and that is the most common reason a new alert looks dead.
     */
    raise(bar, read) {
        if (this.declared.length === 0 || !bar.isRealtime)
            return [];
        const out = [];
        for (let index = 0; index < this.declared.length; index += 1) {
            const entry = this.declared[index];
            const fields = this.resolved[index];
            if (entry === undefined || fields === undefined)
                continue;
            if (read(entry.condChannel) !== true)
                continue;
            if (!this.allowed(index, bar.index, fields.frequency))
                continue;
            this.lastBar[index] = bar.index;
            this.everFired[index] = true;
            out.push({
                key: entry.key,
                title: fields.title,
                message: entry.messageChannel === null ? null : read(entry.messageChannel),
                bar: bar.index,
                time: bar.time,
            });
        }
        return out;
    }
    /**
     * The frequency rule, which nothing else in the program implies.
     *
     * Two engines that guessed would fire different numbers of alerts from one
     * program, so the compiler writes the effective value and this reads it.
     * `everyUpdate` is the one that needs no test here: it fires on every decided
     * execution of the bar, which is why it needs `meta.onUnconfirmed` true to
     * mean anything and is OS3009 without it.
     */
    allowed(index, bar, frequency) {
        if (frequency === ONCE)
            return this.everFired[index] !== true;
        if (frequency === ONCE_PER_BAR)
            return this.lastBar[index] !== bar;
        return true;
    }
}
//# sourceMappingURL=alerts.js.map