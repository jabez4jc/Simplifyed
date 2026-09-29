/**
 * Whether this trade was still held at the close of this bar.
 *
 * The boundaries are the whole of the rule and both are decisions. A trade is
 * held from the close of the bar it opened on, because an entry that settled
 * during a bar is a position that bar ended holding. It is not held at the
 * close of the bar it closed on, because that bar ended flat. So a trade
 * opened and closed inside one bar is held at no close at all, which is what a
 * run that was flat at every mark should report.
 *
 * Every figure in this module that asks which trades are open asks it here, so
 * the curve, the exposure and the count of bars in the market cannot come to
 * three different answers about one bar.
 */
export function openOnBar(trade, barIndex) {
    if (barIndex < trade.openedOnBar)
        return false;
    return trade.closedOnBar === null || barIndex < trade.closedOnBar;
}
/**
 * A ratio against a basis that may not be there to divide by.
 *
 * Capital of zero and a peak of zero are both reachable, and both turn an
 * honest division into a value JSON cannot carry: a report whose worst figure
 * comes back `null` from a round trip is worse than one that says zero. A basis
 * that is not positive has no ratio to state, so the figure beside it, which is
 * money and is always true, is the one a reader is left with.
 */
export function ratioOf(value, basis) {
    return basis > 0 ? value / basis : 0;
}
/**
 * The curve, one point per report bar, in the order the bars arrived.
 *
 * Warmup bars are swept and not reported: their orders were real, so a trade
 * opened during the warmup is already in the fold at the first point, with its
 * charges already paid and its position already marked. A curve that began its
 * fold at the first report bar would lose both, and would lose them silently.
 *
 * The running peak starts at the capital rather than at the first point, so a
 * run that is down from its first bar is in drawdown at its first bar. Starting
 * it at the first point would report every run as having begun at its high.
 *
 * The running trough starts at the capital for the same reason and not for a
 * symmetrical one: a run that is up from its first bar has run up from the
 * money it was given, which is the figure a reader is measuring against. Anchor
 * it at the first point instead and a run that gapped up on bar zero reports
 * that gain as having come from nowhere.
 */
export function equityOver(trades, marks, contract, capital) {
    const points = [];
    let held = [];
    let next = 0;
    let realised = 0;
    let charges = 0;
    let peak = capital;
    let trough = capital;
    let mark = null;
    for (const bar of marks) {
        // Opened by this bar, charges and all. The pointer is why the trades have
        // to arrive in the order they opened.
        while (next < trades.length) {
            const opening = trades[next];
            if (opening === undefined || opening.openedOnBar > bar.barIndex)
                break;
            charges += opening.charges;
            held.push(opening);
            next += 1;
        }
        // Closed by this bar, gross and all. A trade that opened and closed inside
        // one bar is taken on and given up here in that order, so its cost and its
        // gross are both in this point and its position is in none.
        let closedHere = false;
        for (const trade of held) {
            if (closedBy(trade, bar.barIndex)) {
                realised += trade.grossProfit;
                closedHere = true;
            }
        }
        if (closedHere)
            held = held.filter((trade) => !closedBy(trade, bar.barIndex));
        // A close the host did not have leaves the previous mark standing. It is
        // carried across the warmup boundary too, so the first report bar of a run
        // whose close is absent is marked at the last price there was.
        if (bar.close !== null)
            mark = bar.close;
        if (!bar.inReport)
            continue;
        let openProfit = 0;
        let exposure = 0;
        for (const trade of held) {
            // Before the first close there has ever been, a trade is marked at its
            // own entry: no profit, and the position still visible in the exposure.
            const at = mark ?? trade.entryPrice;
            const direction = trade.side === 'long' ? 1 : -1;
            openProfit += direction * (at - trade.entryPrice) * trade.units * contract.pointValue;
            exposure += Math.abs(trade.units * at * contract.pointValue);
        }
        const cash = capital + realised - charges;
        const equity = cash + openProfit;
        if (equity > peak)
            peak = equity;
        if (equity < trough)
            trough = equity;
        const drawdown = equity - peak;
        const runUp = equity - trough;
        points.push({
            barIndex: bar.barIndex,
            time: bar.time,
            realised,
            charges,
            openProfit,
            cash,
            equity,
            exposure,
            drawdown,
            drawdownPercent: ratioOf(drawdown, peak),
            runUp,
            runUpPercent: ratioOf(runUp, trough),
        });
    }
    return points;
}
/**
 * How many of these bars ended with something held.
 *
 * Swept rather than searched: a sorted list of the bars trades opened on, a
 * sorted list of the bars they closed on, and the running difference between
 * how many of each have gone by. That is the boundary rule `openOnBar` states,
 * arrived at from the other side, and the two are asserted to agree over a
 * generated corpus rather than trusted to. A count that disagrees with the
 * curve beside it about which bars were in the market is exactly the kind of
 * defect a reader finds by adding two of the printed figures up.
 */
export function barsInMarketOver(trades, equity) {
    const opens = trades.map((trade) => trade.openedOnBar).sort(ascending);
    const closes = trades
        .filter((trade) => trade.closedOnBar !== null)
        .map((trade) => trade.closedOnBar ?? 0)
        .sort(ascending);
    let opened = 0;
    let closed = 0;
    let live = 0;
    let bars = 0;
    for (const point of equity) {
        while (opened < opens.length && (opens[opened] ?? 0) <= point.barIndex) {
            live += 1;
            opened += 1;
        }
        while (closed < closes.length && (closes[closed] ?? 0) <= point.barIndex) {
            live -= 1;
            closed += 1;
        }
        if (live > 0)
            bars += 1;
    }
    return bars;
}
/** Whether this bar is the bar the trade closed on, or one after it. */
function closedBy(trade, barIndex) {
    return trade.closedOnBar !== null && trade.closedOnBar <= barIndex;
}
/** Smallest first, said once, because a sort without a comparison sorts text. */
function ascending(left, right) {
    return left - right;
}
//# sourceMappingURL=equity.js.map