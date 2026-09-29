import { NO_POSITION, failure } from './errors.js';
/** The spelling a reason uses for a fact the record does not hold. */
const UNNAMED_INSTRUMENT = 'the chart\'s instrument';
const UNNAMED_INTERVAL = 'the chart\'s interval';
/**
 * A run over nothing, OS6010.
 *
 * It names the instrument and the interval because the fix is to choose a pair
 * that has history, and a sentence that does not say which pair was empty
 * sends the reader back to the chart to work it out.
 */
export function noBars(instrument) {
    return failure('OS6010', NO_POSITION, {
        symbol: instrument?.symbol ?? UNNAMED_INSTRUMENT,
        timeframe: instrument?.interval ?? UNNAMED_INTERVAL,
    });
}
/**
 * A bar handed over with no time, OS6025.
 *
 * `host-interface.md` 3.1 states `time` for every bar with no absent case, and
 * the order rule is built on it. Reading a missing one as the absent value, as
 * `barField` would, steps the bar over every calendar fold and makes every
 * session fact absent on a bar that is on the chart: a study draws a gap where
 * the host has data, and nothing says why. It is a bar of the wrong shape, not
 * one out of order, so it has a code and a fix of its own. A time that is not a
 * finite number is no time either.
 */
export function undated(bar, index) {
    const time = bar.time;
    if (typeof time === 'number' && Number.isFinite(time))
        return undefined;
    return failure('OS6025', NO_POSITION, { index });
}
/**
 * A bar whose time does not follow the one before it, OS6011.
 *
 * The first such bar and not a count of them, because the fix is the same
 * whether the feed sent one duplicate or a thousand, and the first one is the
 * only one whose position tells the host where its own ordering went wrong.
 *
 * `previous` is the bar already handed over, or nothing for the first bar of a
 * run, which follows nothing and is therefore always in order. A bar with no
 * time never reaches this comparison: `undated` refuses it first, because a
 * bar dated nothing is not two instants in the wrong order.
 */
export function outOfOrder(bar, previous, index) {
    const time = bar.time;
    const before = previous?.time;
    if (typeof time !== 'number' || typeof before !== 'number')
        return undefined;
    if (time > before)
        return undefined;
    return failure('OS6011', NO_POSITION, { index, time, previous: index - 1 });
}
/** Both checks of a bar handed over, in the order they are made: its shape, then its order. */
export function handOver(bar, previous, index) {
    return undated(bar, index) ?? outOfOrder(bar, previous, index);
}
//# sourceMappingURL=series.js.map