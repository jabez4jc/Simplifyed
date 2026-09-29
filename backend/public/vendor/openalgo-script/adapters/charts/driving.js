/**
 * Walking the bars, for a study and for a strategy.
 *
 * Split from `run.ts` because they are two things. That file decides what an
 * engine is loaded with: the host record, the clock, the settings, the venue.
 * This one decides how the bars are then handed over, and the two differ by
 * exactly one thing, whether frames have to reach the engine between them.
 */
import { hostBar, stateFor } from './bars.js';
import { stopped } from './errors.js';
import { signatureOf } from './settings.js';
import { answersFor } from './venue.js';
/** A study: every bar in one hand-over, which is what `run` is for. */
export function runWhole(engine, bars, ctx, program, settings) {
    const result = engine.run(bars.map(hostBar), bars.map((_, index) => stateFor(index, bars, ctx)));
    if (result.diagnostic !== undefined)
        throw stopped(result.diagnostic);
    return heldFrom(engine, null, bars, program, settings);
}
/**
 * A strategy: one bar at a time, with the venue answering between them.
 *
 * The order is deliver, execute, then ask. A driver that asked the venue before
 * executing would price a fill against a bar the strategy had not seen yet, and
 * one that delivered after executing would let a script read a position its own
 * order on this bar had just created.
 *
 * `supplied` is the whole count rather than the index reached, so `bar.isLast`
 * means the same on this path as on the one above it: a strategy written to act
 * on the final bar acts on the final bar, not on every bar in turn.
 */
export function walkWith(engine, held, bars, ctx, program, settings) {
    for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index];
        if (bar === undefined)
            continue;
        for (const frame of held.pending)
            engine.deliver(frame);
        held.pending = [];
        const result = engine.append(hostBar(bar), stateFor(index, bars, ctx), bars.length);
        if (result.diagnostic !== undefined)
            throw stopped(result.diagnostic);
        answersFor(held, index);
    }
    return heldFrom(engine, held, bars, program, settings);
}
function heldFrom(engine, venue, bars, program, settings) {
    return {
        engine,
        venue,
        signature: signatureOf(program, settings),
        count: bars.length,
        firstTime: bars[0]?.time ?? 0,
        lastTime: bars[bars.length - 1]?.time ?? 0,
    };
}
//# sourceMappingURL=driving.js.map