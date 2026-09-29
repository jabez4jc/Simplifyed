/**
 * Timeframe strings, and the buckets a read folds bars into.
 *
 * `stdlib.md` section 15.2 fixes the spelling: a count and a unit, with the
 * unit letters case sensitive so `"1M"` is one month and `"1m"` one minute, and
 * a bare number read as minutes because that is the form an interval input
 * supplies. This file is that grammar and the arithmetic that follows from it,
 * and nothing else.
 *
 * **A bucket is named by a key rather than by a range**, because a key is one
 * integer per bar and a range is two comparisons and an edge case. Two bars
 * belong to the same requested bar exactly when their open instants give the
 * same key, and a bucket has begun on the first bar whose key is new. Every
 * boundary question in `requests.ts` reduces to that one comparison, which is
 * what keeps the off-by-one out of the fold.
 *
 * **The two families are keyed differently, and the specification says why.**
 * An intraday request is folded by counting, so its key is the instant divided
 * by the period: buckets fall on the same boundaries for every engine, a
 * session gap moves nothing, and a chart whose bars are not evenly spaced still
 * folds. A day, week or month request is folded by the calendar, so its key is
 * a civil date read in the instrument's timezone. That is OS6015's distinction,
 * which exempts the calendar units from the whole multiple rule for exactly
 * this reason.
 *
 * **A calendar bucket with no timezone has no key.** A host states the zone or
 * it does not, and an engine that quietly folded days in UTC would put a day
 * boundary in the middle of a session for most of the world and look right. It
 * is the same answer `library/dates.ts` gives for the same question: a host that
 * states no timezone leaves the call absent rather than answered in a zone
 * nobody chose. A read in that position is absent on every bar of the run, so
 * `request-plan.ts` gives it the reason `req.error` reports: an absence with no
 * explanation is the one failure a trader cannot get past on their own.
 */
import { dayNumber, fieldsIn } from '../stdlib/index.js';
/** The grammar of 15.2. A bare number is minutes, which is the interval form. */
const WRITTEN = /^([0-9]+)(m|h|D|W|M)?$/;
const MINUTE = 60_000;
/** The nominal length of one unit, in minutes, for ordering two timeframes. */
const NOMINAL = {
    m: 1,
    h: 60,
    D: 1440,
    W: 10_080,
    M: 43_200,
};
export function parseTimeframe(text) {
    const match = WRITTEN.exec(text.trim());
    if (match === null)
        return undefined;
    const count = Number(match[1]);
    if (!Number.isInteger(count) || count < 1)
        return undefined;
    return { count, unit: (match[2] ?? 'm'), text };
}
/** Whether this timeframe is folded by counting rather than by the calendar. */
export function isIntraday(timeframe) {
    return timeframe.unit === 'm' || timeframe.unit === 'h';
}
/** Minutes one bar covers, for an intraday timeframe only. */
export function minutesOf(timeframe) {
    return isIntraday(timeframe) ? timeframe.count * NOMINAL[timeframe.unit] : undefined;
}
/**
 * One timeframe's length in minutes, with a month treated as thirty days.
 *
 * Two uses and neither of them folds anything: ordering two timeframes, which
 * is "is the request finer than the chart" and therefore OS6002, and sizing the
 * range of history a host is asked to fetch, which is a floor. A month is not a
 * fixed number of minutes, and where a bucket actually begins is the calendar's
 * job below.
 */
export function nominalMinutes(timeframe) {
    return timeframe.count * NOMINAL[timeframe.unit];
}
/**
 * Minutes one bar of a chart's own interval covers, or nothing where the host
 * stated no interval this engine can read.
 *
 * A month is counted at its nominal length here, which is the answer the
 * session facts need and not a claim about a calendar: any bar of a day or more
 * spans a whole session whatever the exact figure, so every number past the
 * length of a session gives those facts the same answer.
 */
export function barMinutesOf(interval) {
    if (interval === undefined)
        return null;
    const timeframe = parseTimeframe(interval);
    return timeframe === undefined ? null : nominalMinutes(timeframe);
}
/**
 * The bucket an instant falls in, or nothing when no key can be worked out.
 *
 * Nothing comes back for a calendar unit with no zone, and for an instant that
 * is not a finite number. Both leave the read absent rather than folded into a
 * bucket the engine invented.
 */
export function bucketKeyOf(instant, timeframe, zone) {
    if (!Number.isFinite(instant))
        return undefined;
    const minutes = minutesOf(timeframe);
    if (minutes !== undefined)
        return Math.floor(instant / (minutes * MINUTE));
    if (zone === null)
        return undefined;
    const civil = fieldsIn(instant, zone);
    if (civil === null)
        return undefined;
    if (timeframe.unit === 'M') {
        return Math.floor((civil.year * 12 + (civil.month - 1)) / timeframe.count);
    }
    const days = dayNumber(civil.year, civil.month, civil.day);
    if (timeframe.unit === 'D')
        return Math.floor(days / timeframe.count);
    // 1970-01-01 was a Thursday, so shifting by three puts a Monday at the start
    // of week zero, which is the week start `stdlib.md` 12.2 fixes.
    return Math.floor(Math.floor((days + 3) / 7) / timeframe.count);
}
/**
 * Whether the chart's bars can be folded into the requested ones.
 *
 * Two refusals and no third. A request finer than the chart is OS6002, because
 * folding cannot invent bars that were never loaded, and an intraday request
 * that is not a whole multiple of the chart's is OS6015, because an intraday
 * bucket is counted rather than dated and a bucket boundary that fell inside a
 * chart bar would put part of one bar in two requested bars. A day, week or
 * month request is dated, so the multiple rule does not apply to it.
 */
export function foldRefusal(requested, chart) {
    if (nominalMinutes(requested) < nominalMinutes(chart))
        return { code: 'OS6002' };
    const wanted = minutesOf(requested);
    const have = minutesOf(chart);
    if (wanted === undefined || have === undefined)
        return undefined;
    if (wanted % have === 0)
        return undefined;
    return { code: 'OS6015', suggestion: `${Math.ceil(wanted / have) * have}` };
}
//# sourceMappingURL=timeframe.js.map