/**
 * The months a run passed through, in the order it passed through them.
 *
 * **A month holds the change in equity across the closes inside it.** The first
 * point of the curve has nothing before it to be compared with, so it opens the
 * table rather than contributing to it, and every later point contributes what
 * it moved from the point before. The consequence is an identity rather than a
 * claim: the months add up to the equity at the last point less the equity at
 * the first, and nothing that happened during the warmup is attributed to a
 * month it did not happen in.
 *
 * `returnPercent` is that change over the equity at the month's first bar,
 * which is the basis this table states and the reason the figure is a fraction
 * rather than a fraction times a hundred: `drawdownPercent` beside it is
 * `drawdown / peak`, and one report with two conventions is a report a reader
 * has to check every figure of.
 *
 * `trades` counts the trades that closed inside the month, by the time they
 * closed. An open trade is in no month, because the month it will be counted in
 * is not decided yet.
 *
 * **A point with no time is in no month.** A bucket is a calendar fact and a
 * bar with no time states no calendar, so such a point carries its change into
 * the month in force rather than opening one, and where none is in force it is
 * outside the table altogether. That is the honest reading: bucketing it by the
 * month that happened to come before would put money in a month on the strength
 * of nothing.
 */
export function monthlyOver(equity, trades) {
    const buckets = [];
    let previous;
    let current;
    for (const point of equity) {
        const at = monthOf(point.time);
        if (at !== null && (current === undefined || current.year !== at.year || current.month !== at.month)) {
            // The equity this month started from, which is where the previous month
            // left the account and not where this one's first bar closed. Taking the
            // opening point's own equity put the month's first move into the
            // numerator and into the denominator at once: a February that doubled a
            // thousand pounds reported fifty percent, because the gain was divided by
            // the two thousand it had already produced.
            current = {
                year: at.year,
                month: at.month,
                netProfit: 0,
                basis: previous === undefined ? point.equity : previous.equity,
                trades: 0,
            };
            buckets.push(current);
        }
        if (previous !== undefined && current !== undefined) {
            current.netProfit += point.equity - previous.equity;
        }
        previous = point;
    }
    for (const trade of trades) {
        const at = monthOf(trade.closedAt);
        if (at === null)
            continue;
        const bucket = buckets.find((one) => one.year === at.year && one.month === at.month);
        if (bucket !== undefined)
            bucket.trades += 1;
    }
    return buckets.map((one) => ({
        year: one.year,
        month: one.month,
        netProfit: one.netProfit,
        returnPercent: one.basis > 0 ? one.netProfit / one.basis : 0,
        trades: one.trades,
    }));
}
/**
 * The calendar month an instant falls in, in UTC and in no other zone.
 *
 * Decomposed rather than formatted, so no locale, no zone table and no library
 * is involved: the same instant produces the same month on every machine this
 * ever runs on.
 */
function monthOf(time) {
    if (time === null || !Number.isFinite(time) || Math.abs(time) > LATEST_INSTANT)
        return null;
    const at = new Date(time);
    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}
/**
 * The furthest either way an instant can be and still name a month.
 *
 * A finite number outside it decomposes to NaN rather than throwing, and a NaN
 * year never equals the next one, so every point opened a bucket of its own and
 * a fifty thousand bar run produced fifty thousand rows of NaN. The canonical
 * writer then threw a bare error with no code on them, out of core, on a path a
 * host could not tell from an internal fault. The mistake that gets here is
 * ordinary: bar times supplied in nanoseconds rather than milliseconds.
 *
 * A point whose time names no month contributes to no month, which is what an
 * absent time already did.
 */
const LATEST_INSTANT = 8.64e15;
//# sourceMappingURL=monthly.js.map