/**
 * The calendar, `stdlib.md` section 12.2, and the session range test of 12.5.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring. The zone arithmetic is under
 * `src/core/stdlib/calendar`, which raises nothing; this file is the call sites
 * and the one refusal the calendar cannot make for itself.
 *
 * **The zone defaults to the chart's, not to UTC.** Section 12.1 gives the
 * reason: a session study that disagreed with the labels on the chart's own
 * axis would be wrong in the way that is hardest to see. So an absent `zone`
 * argument falls back to `chart.timezone`, which is a host fact, and a host
 * that states no timezone leaves every call here absent rather than answered in
 * a zone nobody chose.
 *
 * **A zone the runtime does not know is OS6005 and never a guess.** An
 * abbreviation is not a zone name: several of them mean two different offsets
 * in different parts of the world, and a session test cannot carry that.
 */
import { civilAt, dateField, instantFrom, isKnownZone, renderPattern, sameDay, startOf, } from '../../stdlib/index.js';
import { entry, numberAt, stringAt } from './binding.js';
import { sessionHolds } from '../session/index.js';
/**
 * The zone a call reads in: the one it was given, or the chart's.
 *
 * A name the runtime's zone table does not hold stops the bar with OS6005,
 * because the alternatives are both worse: an invented offset is silently wrong
 * for half the year, and an absent answer would look exactly like a host that
 * stated no timezone at all.
 */
function zoneAt(ctx, args, index) {
    const given = stringAt(args, index);
    if (given !== null) {
        if (!isKnownZone(given))
            ctx.guard.badZone(ctx.span, given);
        return given;
    }
    const chart = ctx.host.timezone();
    if (typeof chart !== 'string')
        return null;
    if (!isKnownZone(chart))
        ctx.guard.badZone(ctx.span, chart);
    return chart;
}
/** One calendar field read at `t`, which is every entry of the table in 12.2. */
function field(name, which) {
    return entry(`date.${name}`, 't zone', (ctx, args) => dateField(numberAt(args, 0), zoneAt(ctx, args, 1), which));
}
/** One of the three boundaries a timestamp rounds back to. */
function boundary(name, which) {
    return entry(`date.${name}`, 't zone', (ctx, args) => startOf(numberAt(args, 0), zoneAt(ctx, args, 1), which));
}
export const DATE_ENTRIES = [
    field('year', 'year'),
    field('month', 'month'),
    field('day', 'day'),
    field('dayOfWeek', 'dayOfWeek'),
    field('dayOfYear', 'dayOfYear'),
    field('hour', 'hour'),
    field('minute', 'minute'),
    field('second', 'second'),
    field('weekOfYear', 'weekOfYear'),
    boundary('startOfDay', 'day'),
    boundary('startOfWeek', 'week'),
    boundary('startOfMonth', 'month'),
    entry('date.from', 'year month day hour minute second zone', (ctx, args) => instantFrom(numberAt(args, 0), numberAt(args, 1), numberAt(args, 2), numberAt(args, 3), numberAt(args, 4), numberAt(args, 5), zoneAt(ctx, args, 6))),
    entry('date.isSameDay', 'a b zone', (ctx, args) => sameDay(numberAt(args, 0), numberAt(args, 1), zoneAt(ctx, args, 2))),
    entry('date.format', 't pattern zone', (ctx, args) => {
        const zone = zoneAt(ctx, args, 2);
        const rendered = renderPattern(stringAt(args, 1), civilAt(numberAt(args, 0), zone));
        return rendered === null ? null : ctx.guard.string(ctx.span, rendered);
    }),
    entry('session.isIn', 'spec zone', (ctx, args) => sessionHolds(stringAt(args, 0), civilAt(ctx.bar.time, zoneAt(ctx, args, 1)))),
];
//# sourceMappingURL=dates.js.map